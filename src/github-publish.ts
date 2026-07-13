import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitHubPullRequestMetadata } from "./sources/types.js";
import type {
  DiffReviewComment,
  GitHubReviewEvent,
  ReviewLineRange,
  ReviewSessionSnapshot,
  ReviewSubmitPayload,
} from "./types.js";

const PUBLISH_TIMEOUT_MS = 120_000;

type GitHubCommentSide = "LEFT" | "RIGHT";

export interface BuildGitHubReviewPublishPlanOptions {
  event: GitHubReviewEvent;
  body: string;
  submit: ReviewSubmitPayload;
  filePathById: Map<string, string>;
  commentableLinesByFileId: Map<string, { original: ReviewLineRange[]; modified: ReviewLineRange[] }>;
  reviewedHeadSha: string;
  correlationId: string;
}

export type GitHubReviewPublishPlanErrorCode =
  | "already-published"
  | "duplicate-comment-id"
  | "empty-body"
  | "invalid-file"
  | "invalid-file-comment"
  | "invalid-correlation-id"
  | "invalid-line"
  | "invalid-range"
  | "invalid-reviewed-head"
  | "range-crosses-hunks"
  | "stale-publish-plan"
  | "unsupported-side"
  | "unsupported-scope";

export interface GitHubReviewPublishPlanError {
  code: GitHubReviewPublishPlanErrorCode;
  commentId?: string;
  message: string;
}

export interface GitHubReviewComment {
  path: string;
  body: string;
  side: GitHubCommentSide;
  line: number;
  start_line?: number;
  start_side?: GitHubCommentSide;
}

export interface GitHubReviewPayload {
  event: GitHubReviewEvent;
  body: string;
  comments: GitHubReviewComment[];
  commit_id: string;
}

export interface GitHubReviewPublishPlan {
  payload: GitHubReviewPayload | null;
  representedCommentIds: string[];
  errors: GitHubReviewPublishPlanError[];
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export function isGitHubReviewCorrelationId(value: unknown): value is string {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value);
}

export function githubReviewCorrelationMarker(correlationId: string): string {
  if (!isGitHubReviewCorrelationId(correlationId)) {
    throw new Error("GitHub review correlation IDs must be 16-128 URL-safe characters.");
  }
  return `<!-- pi-diff-review-cockpit:review-intent:${correlationId} -->`;
}

function githubSide(side: "original" | "modified"): GitHubCommentSide {
  return side === "original" ? "LEFT" : "RIGHT";
}

function markdownOrderedListItem(index: number, body: string): string {
  const prefix = `${index + 1}. `;
  const indent = " ".repeat(prefix.length);
  const lines = body.trim().replace(/\r\n?/g, "\n").split("\n");
  return `${prefix}${lines[0]}${lines.slice(1).map((line) => line.length === 0 ? "\n" : `\n${indent}${line}`).join("")}`;
}

function markdownFilePath(path: string): string {
  const escaped = path
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `<code>${escaped}</code>`;
}

function acceptedFindingsSection(submit: ReviewSubmitPayload): string | null {
  const bodies = submit.acceptedFindings
    .map((finding) => finding.body)
    .filter((body) => body.trim().length > 0);

  if (bodies.length === 0) {
    return null;
  }

  return [
    "## Accepted AI findings",
    ...bodies.map((body, index) => markdownOrderedListItem(index, body)),
  ].join("\n\n");
}

function appendAcceptedFindings(body: string, submit: ReviewSubmitPayload): string {
  const section = acceptedFindingsSection(submit);
  if (section == null) {
    return body;
  }

  return [body, section].filter((part) => part.length > 0).join("\n\n");
}

function appendFileComments(body: string, comments: Array<{ path: string; body: string }>): string {
  if (comments.length === 0) return body;

  const commentsByPath = new Map<string, string[]>();
  for (const comment of comments) {
    const bodies = commentsByPath.get(comment.path) ?? [];
    bodies.push(comment.body);
    commentsByPath.set(comment.path, bodies);
  }

  const section = [
    "## File comments",
    ...[...commentsByPath.entries()].map(([path, bodies]) => [
      `### ${markdownFilePath(path)}`,
      ...bodies.map((comment, index) => markdownOrderedListItem(index, comment)),
    ].join("\n\n")),
  ].join("\n\n");
  return [body, section].filter((part) => part.length > 0).join("\n\n");
}

function hasCommentableRange(startLine: number, endLine: number, ranges: ReviewLineRange[]): boolean {
  return ranges.some((range) => startLine >= range.start && endLine <= range.end);
}

function isPublished(comment: DiffReviewComment): boolean {
  return comment.status === "published" || comment.published === true;
}

function planError(code: GitHubReviewPublishPlanErrorCode, commentId: string | undefined, message: string): GitHubReviewPublishPlanError {
  return { code, ...(commentId == null ? {} : { commentId }), message };
}

export function buildGitHubReviewPublishPlan(options: BuildGitHubReviewPublishPlanOptions): GitHubReviewPublishPlan {
  const errors: GitHubReviewPublishPlanError[] = [];
  if (options.reviewedHeadSha.trim().length === 0) {
    errors.push(planError("invalid-reviewed-head", undefined, "The reviewed head revision is missing. Refresh the review before publishing."));
  }
  if (!isGitHubReviewCorrelationId(options.correlationId)) {
    errors.push(planError("invalid-correlation-id", undefined, "The GitHub review correlation identifier is invalid."));
  }

  const commentIds = new Set<string>();
  const inlineComments: GitHubReviewComment[] = [];
  const fileComments: Array<{ path: string; body: string }> = [];

  for (const comment of options.submit.comments) {
    if (typeof comment.id !== "string" || comment.id.length === 0) {
      errors.push(planError("duplicate-comment-id", undefined, "A submitted comment is missing its local identifier."));
      continue;
    }
    if (commentIds.has(comment.id)) {
      errors.push(planError("duplicate-comment-id", comment.id, "The submitted comments contain the same local identifier more than once."));
      continue;
    }
    commentIds.add(comment.id);

    if (isPublished(comment)) {
      errors.push(planError("already-published", comment.id, "This comment was already published and cannot be submitted again."));
      continue;
    }
    if (typeof comment.body !== "string" || comment.body.trim().length === 0) {
      errors.push(planError("empty-body", comment.id, "A submitted comment must contain text."));
      continue;
    }

    const path = options.filePathById.get(comment.fileId);
    if (path == null || path.length === 0) {
      errors.push(planError("invalid-file", comment.id, "This comment refers to a file that is not part of the reviewed dataset."));
      continue;
    }

    if (comment.side === "file") {
      if (comment.startLine !== null || comment.endLine !== null) {
        errors.push(planError("invalid-file-comment", comment.id, "A whole-file comment cannot carry a line or range."));
        continue;
      }
      fileComments.push({ path, body: comment.body });
      continue;
    }
    if (comment.side !== "original" && comment.side !== "modified") {
      errors.push(planError("unsupported-side", comment.id, "This comment has an unsupported diff side."));
      continue;
    }
    if (comment.scope !== "git-diff") {
      errors.push(planError("unsupported-scope", comment.id, "Line comments can only be published from the Git diff scope."));
      continue;
    }
    const startLine = comment.startLine;
    if (startLine == null || !Number.isInteger(startLine) || startLine <= 0) {
      errors.push(planError("invalid-line", comment.id, "A line comment must have a positive starting line."));
      continue;
    }

    const endLine = comment.endLine ?? startLine;
    if (!Number.isInteger(endLine) || endLine <= 0) {
      errors.push(planError("invalid-line", comment.id, "A line comment must have a positive ending line."));
      continue;
    }
    if (endLine < startLine) {
      errors.push(planError("invalid-range", comment.id, "A comment range cannot end before it starts."));
      continue;
    }

    const commentableLines = options.commentableLinesByFileId.get(comment.fileId);
    const ranges = comment.side === "original" ? commentableLines?.original : commentableLines?.modified;
    if (ranges == null || !hasCommentableRange(startLine, endLine, ranges)) {
      errors.push(planError("range-crosses-hunks", comment.id, "A line or range comment must stay within one commentable Git diff hunk."));
      continue;
    }

    const side = githubSide(comment.side);
    const reviewComment: GitHubReviewComment = {
      path,
      body: comment.body,
      side,
      line: endLine,
    };
    if (endLine !== startLine) {
      reviewComment.start_line = startLine;
      reviewComment.start_side = side;
    }
    inlineComments.push(reviewComment);
  }

  if (errors.length > 0) {
    return { payload: null, representedCommentIds: [], errors };
  }

  return {
    payload: {
      event: options.event,
      commit_id: options.reviewedHeadSha,
      body: [
        appendFileComments(appendAcceptedFindings(options.body, options.submit), fileComments),
        githubReviewCorrelationMarker(options.correlationId),
      ].filter((part) => part.length > 0).join("\n\n"),
      comments: inlineComments,
    },
    representedCommentIds: options.submit.comments.map((comment) => comment.id),
    errors: [],
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.keys(item as Record<string, unknown>).sort().reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = (item as Record<string, unknown>)[key];
      return sorted;
    }, {});
  });
}

export function revalidateGitHubReviewPublishPlan(options: {
  expectedPlan: GitHubReviewPublishPlan;
  originalOptions: BuildGitHubReviewPublishPlanOptions;
  persistedSnapshot: ReviewSessionSnapshot;
}): GitHubReviewPublishPlan {
  if (options.expectedPlan.payload == null) return options.expectedPlan;

  const errors: GitHubReviewPublishPlanError[] = [];
  const persistedById = new Map((options.persistedSnapshot.comments ?? []).map((comment) => [comment.id, comment]));
  const persistedComments: DiffReviewComment[] = [];
  for (const original of options.originalOptions.submit.comments) {
    const persisted = persistedById.get(original.id);
    if (persisted == null || stableJson(persisted) !== stableJson(original)) {
      errors.push(planError(
        "stale-publish-plan",
        original.id,
        "A comment in the pending GitHub review changed in persisted session state. Review the latest draft before retrying.",
      ));
      continue;
    }
    persistedComments.push(persisted);
  }

  if (options.persistedSnapshot.overallComment !== options.originalOptions.submit.overallComment) {
    errors.push(planError(
      "stale-publish-plan",
      undefined,
      "The persisted overall review changed after the GitHub publish intent was saved.",
    ));
  }
  for (const finding of options.originalOptions.submit.acceptedFindings) {
    if (options.persistedSnapshot.acceptedFindingComments?.[finding.findingId] !== finding.body) {
      errors.push(planError(
        "stale-publish-plan",
        undefined,
        `Accepted finding ${finding.findingId} changed after the GitHub publish intent was saved.`,
      ));
    }
  }
  for (const finding of options.originalOptions.submit.findingStatuses) {
    if (options.persistedSnapshot.findingStatuses?.[finding.findingId] !== finding.status) {
      errors.push(planError(
        "stale-publish-plan",
        undefined,
        `Finding status ${finding.findingId} changed after the GitHub publish intent was saved.`,
      ));
    }
  }
  if (errors.length > 0) return { payload: null, representedCommentIds: [], errors };

  const rebuilt = buildGitHubReviewPublishPlan({
    ...options.originalOptions,
    submit: { ...options.originalOptions.submit, comments: persistedComments },
  });
  if (rebuilt.payload == null
    || stableJson(rebuilt.payload) !== stableJson(options.expectedPlan.payload)
    || stableJson(rebuilt.representedCommentIds) !== stableJson(options.expectedPlan.representedCommentIds)) {
    return {
      payload: null,
      representedCommentIds: [],
      errors: [planError(
        "stale-publish-plan",
        undefined,
        "The persisted GitHub review no longer matches the source-locked publish plan.",
      )],
    };
  }
  return rebuilt;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

interface GitHubPullRequestPreflight {
  state?: unknown;
  locked?: unknown;
  merged?: unknown;
  head?: { sha?: unknown } | null;
  base?: { sha?: unknown } | null;
}

interface GitHubReviewResponse {
  id?: unknown;
  body?: unknown;
  commit_id?: unknown;
  html_url?: unknown;
  submitted_at?: unknown;
}

export interface GitHubReviewPublishReceipt {
  reviewId?: number;
  reviewUrl?: string;
  submittedAt?: string;
  warnings: string[];
}

export interface PublishGitHubReviewDependencies {
  reviewedBaseSha: string;
  cleanupTempDir?: (tempDir: string) => Promise<void>;
  correlationId?: string;
  beforePost?: () => Promise<void>;
}

export class GitHubReviewRefreshRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubReviewRefreshRequiredError";
  }
}

export class GitHubReviewPublishAmbiguousError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubReviewPublishAmbiguousError";
  }
}

export function findGitHubReviewPublishAmbiguousError(error: unknown): GitHubReviewPublishAmbiguousError | null {
  if (error instanceof GitHubReviewPublishAmbiguousError) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const ambiguous = findGitHubReviewPublishAmbiguousError(nested);
      if (ambiguous != null) return ambiguous;
    }
  }
  if (error instanceof Error && error.cause != null && error.cause !== error) {
    return findGitHubReviewPublishAmbiguousError(error.cause);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseGitHubPreflight(output: string, reviewedBaseSha: string, reviewedHeadSha: string): void {
  let preflight: GitHubPullRequestPreflight;
  try {
    preflight = JSON.parse(output) as GitHubPullRequestPreflight;
  } catch {
    throw new GitHubReviewRefreshRequiredError("GitHub could not confirm the current pull request revision. Refresh the review before publishing.");
  }

  const state = typeof preflight.state === "string" ? preflight.state.toLowerCase() : "";
  const headSha = isRecord(preflight.head) && typeof preflight.head.sha === "string" ? preflight.head.sha : "";
  const baseSha = isRecord(preflight.base) && typeof preflight.base.sha === "string" ? preflight.base.sha : "";
  if (state !== "open"
    || preflight.locked !== false
    || preflight.merged !== false
    || baseSha !== reviewedBaseSha
    || headSha !== reviewedHeadSha) {
    throw new GitHubReviewRefreshRequiredError("The pull request changed, closed, merged, or became locked after this review started. Refresh the review before publishing.");
  }
}

function receiptFromResponse(response: GitHubReviewResponse): GitHubReviewPublishReceipt {
  const receipt: GitHubReviewPublishReceipt = { warnings: [] };
  if (typeof response.id === "number" && Number.isSafeInteger(response.id)) receipt.reviewId = response.id;
  if (typeof response.html_url === "string" && response.html_url.length > 0) receipt.reviewUrl = response.html_url;
  if (typeof response.submitted_at === "string" && response.submitted_at.length > 0) receipt.submittedAt = response.submitted_at;
  return receipt;
}

function parseGitHubReviewReceipt(output: string): GitHubReviewPublishReceipt {
  const receipt: GitHubReviewPublishReceipt = { warnings: [] };
  if (output.trim().length === 0) return receipt;

  let response: unknown;
  try {
    response = JSON.parse(output) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    receipt.warnings.push(`GitHub accepted the review, but its response could not be parsed: ${message}`);
    return receipt;
  }

  if (!isRecord(response)) {
    receipt.warnings.push("GitHub accepted the review, but returned an unexpected response.");
    return receipt;
  }
  return receiptFromResponse(response);
}

function parseReviewPages(output: string): GitHubReviewResponse[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error("GitHub returned invalid review history while reconciling a publish intent.", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub returned an unexpected review history while reconciling a publish intent.");
  }

  const reviews = parsed.flatMap((page) => Array.isArray(page) ? page : [page]);
  if (!reviews.every(isRecord)) {
    throw new Error("GitHub returned a malformed review while reconciling a publish intent.");
  }
  return reviews;
}

export async function reconcileGitHubReview(
  pi: ExtensionAPI,
  cwd: string,
  metadata: GitHubPullRequestMetadata,
  options: { correlationId: string; reviewedHeadSha: string },
): Promise<GitHubReviewPublishReceipt | null> {
  const marker = githubReviewCorrelationMarker(options.correlationId);
  const endpoint = `repos/${metadata.owner}/${metadata.repo}/pulls/${metadata.number}/reviews`;
  const args = ["api", endpoint, "--method", "GET", "--paginate", "--slurp"];
  const result = await pi.exec("gh", args, { cwd, timeout: PUBLISH_TIMEOUT_MS });
  if (result.code !== 0) {
    const output = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`Failed to run ${formatCommand("gh", args)} in ${cwd}: ${output}`);
  }

  const matches = parseReviewPages(result.stdout).filter((review) => (
    typeof review.body === "string" && review.body.includes(marker)
  ));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new GitHubReviewPublishAmbiguousError("Multiple GitHub reviews contain the same publish correlation marker; retry is blocked.");
  }

  const match = matches[0];
  if (typeof match.commit_id !== "string" || match.commit_id !== options.reviewedHeadSha) {
    throw new GitHubReviewPublishAmbiguousError("The reconciled GitHub review does not match the source-locked reviewed head; retry is blocked.");
  }
  return receiptFromResponse(match);
}

export async function publishGitHubReview(
  pi: ExtensionAPI,
  cwd: string,
  metadata: GitHubPullRequestMetadata,
  payload: GitHubReviewPayload,
  dependencies: PublishGitHubReviewDependencies,
): Promise<GitHubReviewPublishReceipt> {
  if (typeof payload.commit_id !== "string" || payload.commit_id.trim().length === 0) {
    throw new Error("GitHub reviews must be pinned to the immutable reviewed head revision.");
  }
  if (typeof dependencies.reviewedBaseSha !== "string" || dependencies.reviewedBaseSha.trim().length === 0) {
    throw new Error("GitHub reviews must be pinned to the immutable reviewed base revision.");
  }

  let tempDir: string | null = null;
  let receipt: GitHubReviewPublishReceipt | null = null;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "pi-review-publish-"));
    const jsonPath = join(tempDir, "review.json");
    await writeFile(jsonPath, JSON.stringify(payload), "utf8");

    const pullEndpoint = `repos/${metadata.owner}/${metadata.repo}/pulls/${metadata.number}`;
    const reviewEndpoint = `${pullEndpoint}/reviews`;
    const preflightArgs = ["api", pullEndpoint, "--method", "GET"];
    const preflight = await pi.exec("gh", preflightArgs, { cwd, timeout: PUBLISH_TIMEOUT_MS });
    if (preflight.code !== 0) {
      const output = preflight.stderr.trim() || preflight.stdout.trim() || `exit code ${preflight.code}`;
      throw new Error(`Failed to run ${formatCommand("gh", preflightArgs)} in ${cwd}: ${output}`);
    }
    parseGitHubPreflight(preflight.stdout, dependencies.reviewedBaseSha, payload.commit_id);
    await dependencies.beforePost?.();

    const args = ["api", reviewEndpoint, "--method", "POST", "--input", jsonPath];
    let postFailure: unknown = null;
    let postOutput = "";
    try {
      const result = await pi.exec("gh", args, { cwd, timeout: PUBLISH_TIMEOUT_MS });
      if (result.code !== 0) {
        const output = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
        throw new Error(`Failed to run ${formatCommand("gh", args)} in ${cwd}: ${output}`);
      }
      postOutput = result.stdout;
    } catch (error) {
      postFailure = error;
    }

    if (postFailure != null) {
      if (dependencies.correlationId == null) throw postFailure;
      let reconciled: GitHubReviewPublishReceipt | null;
      try {
        reconciled = await reconcileGitHubReview(pi, cwd, metadata, {
          correlationId: dependencies.correlationId,
          reviewedHeadSha: payload.commit_id,
        });
      } catch (reconciliationError) {
        throw new GitHubReviewPublishAmbiguousError(
          "The GitHub review POST may have succeeded, but its result could not be confirmed. Do not retry.",
          { cause: new AggregateError([postFailure, reconciliationError], "POST and reconciliation both failed.", { cause: postFailure }) },
        );
      }
      if (reconciled == null) {
        throw new GitHubReviewPublishAmbiguousError(
          "The GitHub review POST may have succeeded, but it could not be confirmed. Do not retry.",
          { cause: postFailure },
        );
      }
      reconciled.warnings.push(
        "GitHub accepted the review despite an ambiguous command result; the submission was reconciled by its correlation marker.",
      );
      receipt = reconciled;
    } else {
      receipt = parseGitHubReviewReceipt(postOutput);
    }
  } catch (error) {
    primaryError = error;
  }

  if (tempDir != null) {
    try {
      await (dependencies.cleanupTempDir ?? ((path) => rm(path, { recursive: true, force: true })))(tempDir);
    } catch (error) {
      if (receipt != null) {
        const message = error instanceof Error ? error.message : String(error);
        receipt.warnings.push(`Temporary publish cleanup failed: ${message}`);
      } else {
        cleanupError = error;
      }
    }
  }

  if (primaryError != null && cleanupError != null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "GitHub review publishing failed and temporary cleanup also failed.",
      { cause: primaryError },
    );
  }
  if (primaryError != null) throw primaryError;
  if (receipt == null) throw new Error("GitHub review publishing ended without a receipt.");
  return receipt;
}
