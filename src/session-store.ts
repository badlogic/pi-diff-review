import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseReviewAnalysisJson } from "./analysis.js";
import { isGitHubReviewCorrelationId, type GitHubReviewPublishReceipt } from "./github-publish.js";
import type { ReviewDataset } from "./sources/types.js";
import type {
  DiffReviewComment,
  GitHubReviewPublishIntent,
  GitHubReviewPublishSourceLock,
  ReviewAnalysis,
  ReviewFile,
  ReviewMap,
  ReviewSessionRestoreStatus,
  ReviewSessionSnapshot,
} from "./types.js";

const REVIEW_DIFF_FINGERPRINT_VERSION = 1;
const REVIEW_DIFF_SEMANTICS_VERSION = 2;
const REVIEW_SESSION_RECORD_VERSION = 2;
const SESSION_DIR = "pi-diff-review-cockpit";

export interface ReviewFileFingerprint {
  fileId: string;
  path: string;
  displayPath: string;
  status: string | null;
  oldPath: string | null;
  newPath: string | null;
  patchHash: string;
}

export interface ReviewDiffFingerprint {
  version: 1;
  sourceKey: string;
  sourceKind: string;
  baseRevision: string | null;
  headRevision: string | null;
  fileCount: number;
  files: ReviewFileFingerprint[];
  hash: string;
}

export interface ReviewSessionRecord {
  version: 2;
  revision: number;
  recordHash: string;
  sourceKey: string;
  fingerprint: ReviewDiffFingerprint;
  snapshot: ReviewSessionSnapshot;
  updatedAt: string;
}

export interface ReviewSessionRecordState {
  revision: number;
  recordHash: string;
}

export interface ReviewSessionDescriptor {
  sourceKey: string;
  storagePath: string;
}

export interface ReviewSessionResolution {
  status: ReviewSessionRestoreStatus;
  message: string;
  snapshot: ReviewSessionSnapshot | null;
  analysis: ReviewAnalysis | null;
  updatedAt: string | null;
  reconciliation: ReviewSessionReconciliationCounts | null;
  confirmedPublishIntentToRetire: GitHubReviewPublishIntent | null;
}

export interface ReviewSessionReconciliationCounts {
  previousFileCount: number;
  currentFileCount: number;
  unchangedFileCount: number;
  retainedCommentCount: number;
  droppedCommentCount: number;
  retainedReviewedFileCount: number;
  droppedReviewedFileCount: number;
}

export interface GitHubPublishSessionControllerOptions {
  source: GitHubReviewPublishSourceLock;
  initialIntent?: GitHubReviewPublishIntent | null;
  getSnapshot: () => ReviewSessionSnapshot;
  getRecordState: () => ReviewSessionRecordState | null;
  persistSnapshot: (
    snapshot: ReviewSessionSnapshot,
    transition: GitHubPublishIntentTransition,
  ) => Promise<boolean>;
  now?: () => string;
}

export interface GitHubPublishIntentTransition {
  expected: GitHubReviewPublishIntent | null;
  next: GitHubReviewPublishIntent | null;
  expectedRecordState: ReviewSessionRecordState | null;
}

export interface GitHubPublishRunOptions {
  correlationId: string;
  snapshot: ReviewSessionSnapshot;
  representedCommentIds: string[];
  submittedComments: DiffReviewComment[];
}

export interface GitHubPublishReconciliationResult {
  status: "none" | "cleared" | "confirmed" | "blocked";
  receipt?: GitHubReviewPublishReceipt;
  warning?: string;
}

export interface GitHubPublishAbandonResult {
  status: "none" | "abandoned";
  warning?: string;
}

export interface GitHubPublishSessionController {
  readonly intent: GitHubReviewPublishIntent | null;
  mergeSnapshot(snapshot: ReviewSessionSnapshot): ReviewSessionSnapshot;
  runPublish(
    options: GitHubPublishRunOptions,
    publishRemote: (beforePost: () => Promise<void>) => Promise<GitHubReviewPublishReceipt>,
  ): Promise<GitHubReviewPublishReceipt>;
  reconcileOutstanding(
    reconcileRemote: (intent: GitHubReviewPublishIntent) => Promise<GitHubReviewPublishReceipt | null>,
  ): Promise<GitHubPublishReconciliationResult>;
  abandonOutstanding(): Promise<GitHubPublishAbandonResult>;
}

export class ReviewSessionLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewSessionLoadError";
  }
}

export class GitHubPublishIntentPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubPublishIntentPersistenceError";
  }
}

export class GitHubPublishIntentBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubPublishIntentBlockedError";
  }
}

export class ReviewSessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSessionConflictError";
  }
}

function isPublishedComment(comment: DiffReviewComment): boolean {
  return comment.status === "published" || comment.published === true;
}

export function publishedCommentsFromSnapshot(snapshot: ReviewSessionSnapshot | null | undefined): DiffReviewComment[] {
  return (snapshot?.comments ?? []).filter(isPublishedComment).map((comment) => ({ ...comment }));
}

export function mergeAuthoritativePublishedComments(
  snapshot: ReviewSessionSnapshot,
  publishedComments: Iterable<DiffReviewComment>,
): ReviewSessionSnapshot {
  const authoritativeById = new Map<string, DiffReviewComment>();
  for (const comment of publishedComments) {
    if (isPublishedComment(comment)) authoritativeById.set(comment.id, { ...comment });
  }
  const authoritative = [...authoritativeById.values()];
  if (authoritative.length === 0) return snapshot;

  const publishedIds = new Set(authoritative.map((comment) => comment.id));
  const staged = (snapshot.comments ?? []).filter((comment) => !publishedIds.has(comment.id));
  return {
    ...snapshot,
    comments: [...staged, ...authoritative],
  };
}

export function resolveSubmittedCommentsFromSnapshot(
  submittedComments: readonly DiffReviewComment[],
  snapshot: ReviewSessionSnapshot,
): DiffReviewComment[] {
  const commentsById = new Map((snapshot.comments ?? []).map((comment) => [comment.id, comment]));
  return submittedComments.map((comment) => commentsById.get(comment.id) ?? comment);
}

export function markGitHubReviewCommentsPublished(
  snapshot: ReviewSessionSnapshot,
  commentIds: Iterable<string>,
  receipt: Pick<GitHubReviewPublishReceipt, "reviewId" | "reviewUrl">,
  publishedAt: string,
): ReviewSessionSnapshot {
  const publishedIds = new Set(commentIds);
  if (publishedIds.size === 0) return snapshot;

  return {
    ...snapshot,
    comments: (snapshot.comments ?? []).map((comment) => publishedIds.has(comment.id)
      ? {
          ...comment,
          status: "published",
          published: true,
          publishedAt,
          ...(receipt.reviewId == null ? {} : { githubReviewId: receipt.reviewId }),
          ...(receipt.reviewUrl == null ? {} : { githubReviewUrl: receipt.reviewUrl }),
        }
      : comment),
  };
}

export function publishedCommentsFromConfirmedIntent(
  intent: GitHubReviewPublishIntent | null,
): DiffReviewComment[] {
  if (intent?.status !== "confirmed" || intent.receipt == null) return [];
  const published = markGitHubReviewCommentsPublished(
    { comments: intent.submittedComments },
    intent.representedCommentIds,
    intent.receipt,
    intent.receipt.submittedAt ?? intent.updatedAt,
  );
  return publishedCommentsFromSnapshot(published);
}

function snapshotWithoutPublishIntent(snapshot: ReviewSessionSnapshot): ReviewSessionSnapshot {
  const { githubPublishIntent: _ignored, ...rest } = snapshot;
  return rest;
}

function samePublishSource(left: GitHubReviewPublishSourceLock, right: GitHubReviewPublishSourceLock): boolean {
  return left.sourceKey === right.sourceKey
    && left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase()
    && left.pullNumber === right.pullNumber
    && left.reviewedBaseSha != null
    && right.reviewedBaseSha != null
    && left.reviewedBaseSha === right.reviewedBaseSha
    && left.reviewedHeadSha === right.reviewedHeadSha;
}

function clonePublishIntent(intent: null): null;
function clonePublishIntent(intent: GitHubReviewPublishIntent): GitHubReviewPublishIntent;
function clonePublishIntent(intent: GitHubReviewPublishIntent | null): GitHubReviewPublishIntent | null;
function clonePublishIntent(intent: GitHubReviewPublishIntent | null): GitHubReviewPublishIntent | null {
  if (intent == null) return null;
  return {
    ...intent,
    source: { ...intent.source },
    representedCommentIds: [...intent.representedCommentIds],
    submittedComments: intent.submittedComments.map((comment) => ({ ...comment })),
    ...(intent.receipt == null
      ? {}
      : { receipt: { ...intent.receipt, warnings: [...intent.receipt.warnings] } }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGitHubPublishSessionController(
  options: GitHubPublishSessionControllerOptions,
): GitHubPublishSessionController {
  const now = options.now ?? (() => new Date().toISOString());
  const source = { ...options.source };
  let intent = clonePublishIntent(options.initialIntent ?? null);
  let activeTransition: GitHubPublishIntentTransition | null = null;

  const effectiveIntent = (): GitHubReviewPublishIntent | null => (
    activeTransition == null ? intent : activeTransition.next
  );

  const mergeSnapshot = (snapshot: ReviewSessionSnapshot): ReviewSessionSnapshot => {
    const withoutIntent = snapshotWithoutPublishIntent(snapshot);
    const selectedIntent = effectiveIntent();
    const withPublished = mergeAuthoritativePublishedComments(
      withoutIntent,
      publishedCommentsFromConfirmedIntent(selectedIntent),
    );
    return selectedIntent == null
      ? withPublished
      : { ...withPublished, githubPublishIntent: clonePublishIntent(selectedIntent) };
  };

  const requirePersistence = async (
    snapshot: ReviewSessionSnapshot,
    transition: GitHubPublishIntentTransition,
    message: string,
  ): Promise<void> => {
    let saved: boolean;
    try {
      saved = await options.persistSnapshot(snapshot, transition);
    } catch (error) {
      throw new GitHubPublishIntentPersistenceError(`${message} ${errorMessage(error)}`, { cause: error });
    }
    if (!saved) throw new GitHubPublishIntentPersistenceError(message);
  };

  const persistIntent = async (
    nextIntent: GitHubReviewPublishIntent | null,
    snapshot: ReviewSessionSnapshot,
    failureMessage: string,
  ): Promise<void> => {
    if (activeTransition != null) {
      throw new GitHubPublishIntentBlockedError("A GitHub publish intent transition is already being saved.");
    }
    const nextInternal = clonePublishIntent(nextIntent);
    const expectedInternal = clonePublishIntent(intent);
    const expectedRecordState = options.getRecordState();
    activeTransition = {
      expected: expectedInternal,
      next: nextInternal,
      expectedRecordState: expectedRecordState == null ? null : { ...expectedRecordState },
    };
    const persistedTransition: GitHubPublishIntentTransition = {
      expected: clonePublishIntent(expectedInternal),
      next: clonePublishIntent(nextInternal),
      expectedRecordState: expectedRecordState == null ? null : { ...expectedRecordState },
    };
    try {
      await requirePersistence(mergeSnapshot(snapshot), persistedTransition, failureMessage);
      intent = nextInternal;
    } finally {
      activeTransition = null;
    }
  };

  const beginPublish = async (run: GitHubPublishRunOptions): Promise<void> => {
    if (intent?.status === "pending" || intent?.status === "ambiguous") {
      throw new GitHubPublishIntentBlockedError(
        "An outstanding GitHub publish intent must be reconciled before another publish can start.",
      );
    }
    if (source.reviewedBaseSha == null || source.reviewedBaseSha.length === 0) {
      throw new GitHubPublishIntentBlockedError(
        "The reviewed base revision is missing from the GitHub publish source lock. Refresh the review before publishing.",
      );
    }

    const representedIds = new Set(run.representedCommentIds);
    if (representedIds.size !== run.representedCommentIds.length
      || run.submittedComments.length !== representedIds.size
      || run.submittedComments.some((comment, index) => comment.id !== run.representedCommentIds[index])) {
      throw new Error("The publish intent must contain exactly the comments represented by the GitHub review payload, in payload order.");
    }

    const timestamp = now();
    const pending: GitHubReviewPublishIntent = {
      version: 1,
      status: "pending",
      correlationId: run.correlationId,
      source: { ...source },
      representedCommentIds: [...run.representedCommentIds],
      submittedComments: run.submittedComments.map((comment) => ({ ...comment })),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await persistIntent(
      pending,
      run.snapshot,
      "Could not durably save the pending publish intent, so no GitHub review was sent.",
    );
  };

  const markPostStarting = async (): Promise<void> => {
    if (intent == null || (intent.status !== "pending" && intent.status !== "ambiguous")) {
      throw new GitHubPublishIntentBlockedError("No pending GitHub publish intent is available for POST.");
    }
    const ambiguous: GitHubReviewPublishIntent = {
      ...intent,
      status: "ambiguous",
      updatedAt: now(),
    };
    await persistIntent(
      ambiguous,
      options.getSnapshot(),
      "Could not durably mark the GitHub publish intent ambiguous, so no POST was attempted.",
    );
  };

  const confirm = async (receipt: GitHubReviewPublishReceipt): Promise<void> => {
    if (intent == null) throw new GitHubPublishIntentBlockedError("No GitHub publish intent is available to confirm.");
    const publishedAt = receipt.submittedAt ?? now();
    const submitted = markGitHubReviewCommentsPublished(
      { comments: intent.submittedComments },
      intent.representedCommentIds,
      receipt,
      publishedAt,
    );
    const latest = snapshotWithoutPublishIntent(options.getSnapshot());
    const merged = mergeAuthoritativePublishedComments(latest, publishedCommentsFromSnapshot(submitted));
    const confirmed: GitHubReviewPublishIntent = {
      ...intent,
      status: "confirmed",
      updatedAt: now(),
      receipt: {
        ...(receipt.reviewId == null ? {} : { reviewId: receipt.reviewId }),
        ...(receipt.reviewUrl == null ? {} : { reviewUrl: receipt.reviewUrl }),
        ...(receipt.submittedAt == null ? {} : { submittedAt: receipt.submittedAt }),
        warnings: [...receipt.warnings],
      },
    };
    await persistIntent(
      confirmed,
      merged,
      "GitHub accepted the review, but its confirmed receipt could not be durably saved. Do not retry this submission.",
    );
  };

  const recordAmbiguousFailure = async (failure: unknown): Promise<void> => {
    if (intent?.status !== "ambiguous") return;
    const ambiguous: GitHubReviewPublishIntent = {
      ...intent,
      lastError: errorMessage(failure),
      updatedAt: now(),
    };
    try {
      await persistIntent(
        ambiguous,
        options.getSnapshot(),
        "The GitHub publish result was ambiguous and that state could not be durably saved. Do not retry.",
      );
    } catch (persistenceError) {
      throw new AggregateError(
        [failure, persistenceError],
        "The GitHub publish result was ambiguous and preserving that state also failed.",
        { cause: failure },
      );
    }
  };

  return {
    get intent(): GitHubReviewPublishIntent | null {
      return clonePublishIntent(intent);
    },
    mergeSnapshot,
    async runPublish(run, publishRemote): Promise<GitHubReviewPublishReceipt> {
      await beginPublish(run);
      try {
        const receipt = await publishRemote(markPostStarting);
        await confirm(receipt);
        return receipt;
      } catch (error) {
        await recordAmbiguousFailure(error);
        throw error;
      }
    },
    async reconcileOutstanding(reconcileRemote): Promise<GitHubPublishReconciliationResult> {
      if (intent == null || intent.status === "confirmed") return { status: "none" };
      if (!samePublishSource(intent.source, source)) {
        return {
          status: "blocked",
          warning: "The saved GitHub publish intent does not match this review source lock. Review can continue, but publishing is blocked; use --abandon-ambiguous-publish only if you accept the risk of creating a duplicate GitHub review.",
        };
      }

      const receipt = await reconcileRemote(clonePublishIntent(intent));
      if (receipt != null) {
        await confirm(receipt);
        return { status: "confirmed", receipt };
      }
      if (intent.status === "ambiguous") {
        return {
          status: "blocked",
          warning: "The prior GitHub publish remains ambiguous. Review can continue, but publishing is blocked; use --abandon-ambiguous-publish only if you accept the risk of creating a duplicate GitHub review.",
        };
      }

      await persistIntent(
        null,
        options.getSnapshot(),
        "Could not durably clear the unattempted pending publish intent; publishing remains blocked.",
      );
      return { status: "cleared" };
    },
    async abandonOutstanding(): Promise<GitHubPublishAbandonResult> {
      if (intent == null || intent.status === "confirmed") return { status: "none" };
      await persistIntent(
        null,
        options.getSnapshot(),
        "Could not durably abandon the outstanding GitHub publish intent; publishing remains blocked.",
      );
      return {
        status: "abandoned",
        warning: "The ambiguous publish intent was abandoned. Retrying can create a duplicate GitHub review if the prior request was accepted.",
      };
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string): string {
  const segment = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || "review";
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

function sourceKeyForDataset(dataset: ReviewDataset): string {
  const github = dataset.source.github;
  if (github) {
    return `github:${github.owner.toLowerCase()}/${github.repo.toLowerCase()}:pull/${github.number}`;
  }

  return `local:${dataset.repoRoot}:${dataset.source.kind}`;
}

function sessionDirectoryName(sourceKey: string): string {
  const label = safeSegment(sourceKey).slice(0, 80);
  return `${label}-${sha256(sourceKey).slice(0, 16)}`;
}

async function runGitAllowFailure(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | null> {
  const result = await pi.exec("git", args, { cwd });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function resolveRevision(pi: ExtensionAPI, cwd: string, revision: string | null): Promise<string | null> {
  if (revision == null) return null;
  return await runGitAllowFailure(pi, cwd, ["rev-parse", "--verify", revision]) ?? revision;
}

async function gitCommonDir(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const value = await runGitAllowFailure(pi, repoRoot, ["rev-parse", "--git-common-dir"]);
  if (value == null) {
    return join(repoRoot, ".git");
  }
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function analysisFiles(dataset: ReviewDataset): ReviewFile[] {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const selected = dataset.analysisFileIds
    .map((fileId) => fileById.get(fileId))
    .filter((file): file is ReviewFile => file != null);
  return selected.length > 0 ? selected : dataset.files;
}

function comparisonForFingerprint(file: ReviewFile) {
  return file.gitDiff ?? file.lastCommit ?? Object.values(file.commitComparisons)[0] ?? null;
}

async function buildFileFingerprint(file: ReviewFile, getFilePatch: (file: ReviewFile) => Promise<string>): Promise<ReviewFileFingerprint> {
  const comparison = comparisonForFingerprint(file);
  const patch = await getFilePatch(file);
  const structuralFallback = {
    id: file.id,
    path: file.path,
    worktreeStatus: file.worktreeStatus,
    comparison,
  };

  return {
    fileId: file.id,
    path: file.path,
    displayPath: comparison?.displayPath ?? file.path,
    status: comparison?.status ?? file.worktreeStatus,
    oldPath: comparison?.oldPath ?? null,
    newPath: comparison?.newPath ?? null,
    patchHash: sha256(patch.length > 0 ? patch : stableJson(structuralFallback)),
  };
}

export async function buildReviewDiffFingerprint(
  pi: ExtensionAPI,
  dataset: ReviewDataset,
  getFilePatch: (file: ReviewFile) => Promise<string>,
): Promise<ReviewDiffFingerprint> {
  const sourceKey = sourceKeyForDataset(dataset);
  const files = await Promise.all(analysisFiles(dataset).map((file) => buildFileFingerprint(file, getFilePatch)));
  files.sort((left, right) => left.fileId.localeCompare(right.fileId));

  const baseRevision = await resolveRevision(pi, dataset.repoRoot, dataset.source.baseRevision);
  const headRevision = await resolveRevision(pi, dataset.repoRoot, dataset.source.headRevision);
  const hashInput = {
    reviewDiffSemanticsVersion: REVIEW_DIFF_SEMANTICS_VERSION,
    sourceKey,
    sourceKind: dataset.source.kind,
    baseRevision,
    headRevision,
    files,
  };

  return {
    version: REVIEW_DIFF_FINGERPRINT_VERSION,
    sourceKey,
    sourceKind: dataset.source.kind,
    baseRevision,
    headRevision,
    fileCount: files.length,
    files,
    hash: sha256(stableJson(hashInput)),
  };
}

export async function getReviewSessionDescriptor(pi: ExtensionAPI, dataset: ReviewDataset): Promise<ReviewSessionDescriptor> {
  const sourceKey = sourceKeyForDataset(dataset);
  const commonDir = await gitCommonDir(pi, dataset.repoRoot);
  return {
    sourceKey,
    storagePath: join(commonDir, SESSION_DIR, "reviews", sessionDirectoryName(sourceKey), "session.json"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasUniqueStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(isNonemptyString)
    && new Set(value).size === value.length;
}

const REVIEW_SCOPES = new Set(["git-diff", "last-commit", "commit", "all-files"]);
const COMMENT_SIDES = new Set(["original", "modified", "file"]);

function isReviewComment(value: unknown): value is DiffReviewComment {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id", "fileId", "scope", "commitSha", "side", "startLine", "endLine", "body",
    "status", "published", "publishedAt", "githubReviewId", "githubReviewUrl",
  ])) return false;
  if (!isNonemptyString(value.id)
    || !isNonemptyString(value.fileId)
    || typeof value.scope !== "string"
    || !REVIEW_SCOPES.has(value.scope)
    || typeof value.side !== "string"
    || !COMMENT_SIDES.has(value.side)
    || typeof value.body !== "string") return false;
  if (value.scope === "commit") {
    if (!isNonemptyString(value.commitSha)) return false;
  } else if (value.commitSha != null) return false;
  if (value.status != null && value.status !== "staged" && value.status !== "published") return false;
  if (value.published != null && typeof value.published !== "boolean") return false;
  if (!isOptionalString(value.publishedAt) || !isOptionalString(value.githubReviewUrl)) return false;
  if (value.githubReviewId != null && !isPositiveInteger(value.githubReviewId)) return false;

  if (value.side === "file") {
    if (value.startLine !== null || value.endLine !== null) return false;
  } else if (!isPositiveInteger(value.startLine)
    || (value.endLine !== null
      && (!isPositiveInteger(value.endLine) || value.startLine > value.endLine))) {
    return false;
  }

  const isPublished = value.status === "published" || value.published === true;
  if (isPublished) {
    if (value.status !== "published" || value.published !== true || !isNonemptyString(value.publishedAt)) return false;
  } else if (value.publishedAt != null || value.githubReviewId != null || value.githubReviewUrl != null) {
    return false;
  }
  return true;
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isBooleanRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "boolean");
}

function isFindingStatusRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => (
    item === "new" || item === "accepted-comment" || item === "dismissed" || item === "accepted-risk"
  ));
}

function isReviewAnalysis(value: unknown): value is ReviewAnalysis {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "status", "message", "chapters", "findings", "coverage", "approvalPacket",
  ])) return false;
  if ((value.status !== "ready" && value.status !== "fallback" && value.status !== "failed")
    || typeof value.message !== "string"
    || !Array.isArray(value.chapters)
    || !Array.isArray(value.findings)
    || !isRecord(value.coverage)
    || !hasOnlyKeys(value.coverage, [
      "fileCount", "originalLineCount", "modifiedLineCount", "unmappedFileCount",
      "unmappedOriginalLineCount", "unmappedModifiedLineCount",
    ])
    || !Object.values(value.coverage).every(isNonnegativeInteger)
    || !isRecord(value.approvalPacket)) return false;
  try {
    parseReviewAnalysisJson(JSON.stringify({
      chapters: value.chapters,
      findings: value.findings,
      approvalPacket: value.approvalPacket,
    }));
    return true;
  } catch {
    return false;
  }
}

const MAP_STATUSES = new Set(["provisional", "mapping", "semantic", "semantic-repaired", "fallback"]);
const MAP_PRIORITIES = new Set(["review-first", "high-attention", "standard", "low-attention", "reference"]);
const VISIT_ROLES = new Set(["start-here", "contract", "implementation", "caller", "integration", "removed-path", "verification", "reference"]);
const CHANGE_STATUSES = new Set(["modified", "added", "deleted", "renamed"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isMapRange(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["fileId", "path", "side", "startLine", "endLine"])
    && isNonemptyString(value.fileId)
    && isNonemptyString(value.path)
    && (value.side === "original" || value.side === "modified")
    && isPositiveInteger(value.startLine)
    && isPositiveInteger(value.endLine)
    && value.startLine <= value.endLine;
}

export function isReviewMap(value: unknown): value is ReviewMap {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["version", "status", "sourceFingerprint", "strategyVersion", "story", "changeUnits", "chapters", "coverage", "diagnostics"])
    || value.version !== 2
    || !MAP_STATUSES.has(String(value.status))
    || !isNonemptyString(value.sourceFingerprint)
    || !isNonemptyString(value.strategyVersion)
    || !isRecord(value.story)
    || !hasOnlyKeys(value.story, ["intent", "behaviorBefore", "behaviorAfter", "primaryFlows", "removedOrReplacedBehavior"])
    || typeof value.story.intent !== "string"
    || typeof value.story.behaviorBefore !== "string"
    || typeof value.story.behaviorAfter !== "string"
    || !isStringArray(value.story.primaryFlows)
    || !isStringArray(value.story.removedOrReplacedBehavior)
    || !Array.isArray(value.changeUnits)
    || !Array.isArray(value.chapters)
    || !isRecord(value.coverage)
    || !hasOnlyKeys(value.coverage, [
      "fileCount", "originalLineCount", "modifiedLineCount", "unmappedFileCount",
      "unmappedOriginalLineCount", "unmappedModifiedLineCount", "overlappingOriginalLineCount",
      "overlappingModifiedLineCount",
    ])
    || !Object.values(value.coverage).every(isNonnegativeInteger)
    || !isStringArray(value.diagnostics)) return false;

  const unitIds = new Set<string>();
  const unitFileIds = new Map<string, string>();
  for (const unit of value.changeUnits) {
    if (!isRecord(unit)
      || !hasOnlyKeys(unit, ["id", "fileId", "path", "ranges", "status", "commitIds", "symbol"])
      || !isNonemptyString(unit.id)
      || unitIds.has(unit.id)
      || !isNonemptyString(unit.fileId)
      || !isNonemptyString(unit.path)
      || (unit.symbol != null && typeof unit.symbol !== "string")
      || !Array.isArray(unit.ranges)
      || unit.ranges.length === 0
      || !unit.ranges.every(isMapRange)
      || !CHANGE_STATUSES.has(String(unit.status))
      || !isStringArray(unit.commitIds)) return false;
    if (unit.ranges.some((range) => (range as { fileId: string }).fileId !== unit.fileId)) return false;
    unitIds.add(unit.id);
    unitFileIds.set(unit.id, unit.fileId);
  }

  const chapterIds = new Set<string>();
  const visitIds = new Set<string>();
  const assignedUnitIds = new Set<string>();
  let expectedOrder = 1;
  for (const chapter of value.chapters) {
    if (!isRecord(chapter)
      || !hasOnlyKeys(chapter, [
        "id", "title", "objective", "whyItMatters", "summary", "reviewOrder", "reviewWeight",
        "priority", "priorityReason", "attentionTags", "dependsOn", "reviewQuestions", "changeFlow",
        "visits", "testEvidence", "exitCriteria", "fileIds", "ranges", "findingIds",
      ])
      || !isNonemptyString(chapter.id)
      || chapterIds.has(chapter.id)
      || !isNonemptyString(chapter.title)
      || !isNonemptyString(chapter.objective)
      || !isNonemptyString(chapter.whyItMatters)
      || !isNonemptyString(chapter.summary)
      || chapter.reviewOrder !== expectedOrder++
      || !isPositiveInteger(chapter.reviewWeight)
      || !MAP_PRIORITIES.has(String(chapter.priority))
      || !isNonemptyString(chapter.priorityReason)
      || !isStringArray(chapter.attentionTags)
      || !isStringArray(chapter.dependsOn)
      || !isStringArray(chapter.reviewQuestions)
      || !isStringArray(chapter.changeFlow)
      || !Array.isArray(chapter.visits)
      || !Array.isArray(chapter.testEvidence)
      || !isStringArray(chapter.exitCriteria)
      || !isStringArray(chapter.fileIds)
      || !Array.isArray(chapter.ranges)
      || !chapter.ranges.every(isMapRange)
      || !isStringArray(chapter.findingIds)) return false;
    chapterIds.add(chapter.id);
    for (const visit of chapter.visits) {
      if (!isRecord(visit)
        || !hasOnlyKeys(visit, ["id", "fileId", "changeUnitIds", "role", "reason", "focus"])
        || !isNonemptyString(visit.id)
        || visitIds.has(visit.id)
        || !isNonemptyString(visit.fileId)
        || !isStringArray(visit.changeUnitIds)
        || visit.changeUnitIds.length === 0
        || !VISIT_ROLES.has(String(visit.role))
        || !isNonemptyString(visit.reason)
        || !isStringArray(visit.focus)
        || visit.changeUnitIds.some((id) => !unitIds.has(id) || unitFileIds.get(id) !== visit.fileId)) return false;
      if (visit.changeUnitIds.some((id) => assignedUnitIds.has(id))) return false;
      visit.changeUnitIds.forEach((id) => assignedUnitIds.add(id));
      visitIds.add(visit.id);
    }
    for (const evidence of chapter.testEvidence) {
      if (!isRecord(evidence)
        || !hasOnlyKeys(evidence, ["visitIds", "proves", "doesNotProve"])
        || !isStringArray(evidence.visitIds)
        || !isStringArray(evidence.proves)
        || !isStringArray(evidence.doesNotProve)) return false;
    }
  }
  const chapters = value.chapters as Array<{
    dependsOn: string[];
    testEvidence: Array<{ visitIds: string[] }>;
  }>;
  return chapters.every((chapter) => chapter.dependsOn.every((id) => chapterIds.has(id)))
    && chapters.every((chapter) => chapter.testEvidence.every((evidence) => evidence.visitIds.every((id) => visitIds.has(id))));
}

function isPublishIntent(value: unknown): value is GitHubReviewPublishIntent {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "version", "status", "correlationId", "source", "representedCommentIds",
    "submittedComments", "createdAt", "updatedAt", "lastError", "receipt",
  ]) || value.version !== 1) return false;
  if (value.status !== "pending" && value.status !== "confirmed" && value.status !== "ambiguous") return false;
  if (!isGitHubReviewCorrelationId(value.correlationId)
    || !isNonemptyString(value.createdAt)
    || !isNonemptyString(value.updatedAt)) return false;
  if (!isRecord(value.source)
    || !hasOnlyKeys(value.source, ["sourceKey", "owner", "repo", "pullNumber", "reviewedBaseSha", "reviewedHeadSha"])
    || !isNonemptyString(value.source.sourceKey)
    || !isNonemptyString(value.source.owner)
    || !isNonemptyString(value.source.repo)
    || !isPositiveInteger(value.source.pullNumber)
    || (value.source.reviewedBaseSha != null && !isNonemptyString(value.source.reviewedBaseSha))
    || !isNonemptyString(value.source.reviewedHeadSha)) return false;
  const representedCommentIds = value.representedCommentIds;
  if (!hasUniqueStrings(representedCommentIds)) return false;
  if (!Array.isArray(value.submittedComments) || !value.submittedComments.every(isReviewComment)) return false;
  const submittedIds = value.submittedComments.map((comment) => comment.id);
  if (new Set(submittedIds).size !== submittedIds.length
    || submittedIds.length !== representedCommentIds.length
    || submittedIds.some((id, index) => id !== representedCommentIds[index])) return false;
  if (value.lastError != null && typeof value.lastError !== "string") return false;
  if (value.receipt != null) {
    if (!isRecord(value.receipt)
      || !hasOnlyKeys(value.receipt, ["reviewId", "reviewUrl", "submittedAt", "warnings"])
      || !Array.isArray(value.receipt.warnings)
      || !value.receipt.warnings.every((warning) => typeof warning === "string")) return false;
    if (value.receipt.reviewId != null && !isPositiveInteger(value.receipt.reviewId)) return false;
    if (value.receipt.reviewUrl != null && typeof value.receipt.reviewUrl !== "string") return false;
    if (value.receipt.submittedAt != null && typeof value.receipt.submittedAt !== "string") return false;
  }
  return value.status === "confirmed" ? value.receipt != null : value.receipt == null;
}

function isGitHubContextComment(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "author", "body", "createdAt", "url"])
    && isNonemptyString(value.id)
    && typeof value.author === "string"
    && typeof value.body === "string"
    && isNonemptyString(value.createdAt)
    && isNonemptyString(value.url);
}

function hasUniqueRecordIds(values: unknown[], predicate: (value: unknown) => boolean): boolean {
  if (!values.every(predicate)) return false;
  const ids = values.map((value) => (value as { id: string }).id);
  return new Set(ids).size === ids.length;
}

function isGitHubReviewSummary(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "author", "body", "createdAt", "url", "state"])
    && isGitHubContextComment({
      id: value.id,
      author: value.author,
      body: value.body,
      createdAt: value.createdAt,
      url: value.url,
    })
    && (value.state === "APPROVED"
      || value.state === "CHANGES_REQUESTED"
      || value.state === "COMMENTED"
      || value.state === "DISMISSED"
      || value.state === "PENDING");
}

function isGitHubReviewThread(value: unknown): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["id", "isResolved", "isOutdated", "path", "side", "line", "originalLine", "comments"])
    || !isNonemptyString(value.id)
    || typeof value.isResolved !== "boolean"
    || typeof value.isOutdated !== "boolean"
    || !isNonemptyString(value.path)
    || (value.side !== null && value.side !== "original" && value.side !== "modified")
    || (value.line !== null && !isPositiveInteger(value.line))
    || (value.originalLine !== null && !isPositiveInteger(value.originalLine))
    || !Array.isArray(value.comments)) return false;
  return hasUniqueRecordIds(value.comments, isGitHubContextComment);
}

export function isGitHubReviewContextSnapshot(value: unknown): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "owner", "repo", "pullNumber", "reviewedHeadSha", "remoteHeadSha", "fetchedAt",
      "conversationComments", "reviews", "threads", "diagnostics",
    ])
    || !isNonemptyString(value.owner)
    || !isNonemptyString(value.repo)
    || !isPositiveInteger(value.pullNumber)
    || !isNonemptyString(value.reviewedHeadSha)
    || !isNonemptyString(value.remoteHeadSha)
    || !isNonemptyString(value.fetchedAt)
    || !Array.isArray(value.conversationComments)
    || !Array.isArray(value.reviews)
    || !Array.isArray(value.threads)
    || !Array.isArray(value.diagnostics)
    || !value.diagnostics.every((item) => typeof item === "string")) return false;
  return hasUniqueRecordIds(value.conversationComments, isGitHubContextComment)
    && hasUniqueRecordIds(value.reviews, isGitHubReviewSummary)
    && hasUniqueRecordIds(value.threads, isGitHubReviewThread);
}

function isReviewSnapshot(value: unknown): value is ReviewSessionSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "map", "analysis", "overallComment", "comments", "acceptedFindingComments", "findingStatuses",
    "reviewedFiles", "reviewedChapters", "reviewedVisits", "activeFileId", "activeVisitId", "activeSidebarTab", "currentScope",
    "selectedCommitSha", "activeInsight", "hideUnchanged", "wrapLines", "sidebarCollapsed",
    "aiReviewCompleted", "aiReviewStatus", "dismissedFindingLocationKeys", "githubPublishIntent", "githubContext",
    "updatedAt",
  ])) return false;
  if (value.map != null && !isReviewMap(value.map)) return false;
  if (value.analysis != null && !isReviewAnalysis(value.analysis)) return false;
  if (value.overallComment != null && typeof value.overallComment !== "string") return false;
  if (value.comments != null) {
    if (!Array.isArray(value.comments) || !value.comments.every(isReviewComment)) return false;
    const commentIds = value.comments.map((comment) => comment.id);
    if (new Set(commentIds).size !== commentIds.length) return false;
  }
  if (value.acceptedFindingComments != null && !isStringRecord(value.acceptedFindingComments)) return false;
  if (value.findingStatuses != null && !isFindingStatusRecord(value.findingStatuses)) return false;
  if (value.reviewedFiles != null && !isBooleanRecord(value.reviewedFiles)) return false;
  if (value.reviewedChapters != null && !isBooleanRecord(value.reviewedChapters)) return false;
  if (value.reviewedVisits != null && !isBooleanRecord(value.reviewedVisits)) return false;
  if (!isOptionalString(value.activeFileId) || !isOptionalString(value.activeVisitId) || !isOptionalString(value.selectedCommitSha)) return false;
  if (value.activeSidebarTab != null
    && value.activeSidebarTab !== "review-map"
    && value.activeSidebarTab !== "files"
    && value.activeSidebarTab !== "findings") return false;
  if (value.currentScope != null && (typeof value.currentScope !== "string" || !REVIEW_SCOPES.has(value.currentScope))) return false;
  if (value.activeInsight != null) {
    if (!isRecord(value.activeInsight)
      || !hasOnlyKeys(value.activeInsight, ["type", "id"])
      || (value.activeInsight.type !== "default"
        && value.activeInsight.type !== "chapter"
        && value.activeInsight.type !== "finding"
        && value.activeInsight.type !== "comment")) return false;
    if (value.activeInsight.type === "default") {
      if (value.activeInsight.id !== null) return false;
    } else if (!isNonemptyString(value.activeInsight.id)) return false;
  }
  for (const key of ["hideUnchanged", "wrapLines", "sidebarCollapsed", "aiReviewCompleted"] as const) {
    if (value[key] != null && typeof value[key] !== "boolean") return false;
  }
  if (value.aiReviewStatus != null
    && value.aiReviewStatus !== "idle"
    && value.aiReviewStatus !== "running"
    && value.aiReviewStatus !== "done"
    && value.aiReviewStatus !== "failed") return false;
  if (value.dismissedFindingLocationKeys != null && !hasUniqueStrings(value.dismissedFindingLocationKeys)) return false;
  if (value.githubPublishIntent != null && !isPublishIntent(value.githubPublishIntent)) return false;
  if (value.githubContext != null && !isGitHubReviewContextSnapshot(value.githubContext)) return false;
  return value.updatedAt == null || isNonemptyString(value.updatedAt);
}

function isReviewFingerprint(value: unknown): value is ReviewDiffFingerprint {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "version", "sourceKey", "sourceKind", "baseRevision", "headRevision", "fileCount", "files", "hash",
  ])) return false;
  if (value.version !== 1
    || !isNonemptyString(value.sourceKey)
    || !isNonemptyString(value.sourceKind)
    || !isOptionalString(value.baseRevision)
    || !isOptionalString(value.headRevision)
    || !isNonnegativeInteger(value.fileCount)
    || !isNonemptyString(value.hash)
    || !Array.isArray(value.files)
    || value.files.length !== value.fileCount) return false;
  const fileIds = new Set<string>();
  for (const file of value.files) {
    if (!isRecord(file)
      || !hasOnlyKeys(file, ["fileId", "path", "displayPath", "status", "oldPath", "newPath", "patchHash"])
      || !isNonemptyString(file.fileId)
      || !isNonemptyString(file.path)
      || !isNonemptyString(file.displayPath)
      || !isOptionalString(file.status)
      || !isOptionalString(file.oldPath)
      || !isOptionalString(file.newPath)
      || !isNonemptyString(file.patchHash)
      || fileIds.has(file.fileId)) return false;
    fileIds.add(file.fileId);
  }
  return true;
}

function recordKeysBelongTo(value: Record<string, unknown> | undefined, knownIds: ReadonlySet<string>): boolean {
  return value == null || Object.keys(value).every((id) => knownIds.has(id));
}

function hasValidSessionReferences(
  record: Pick<ReviewSessionRecord, "fingerprint" | "snapshot">,
): boolean {
  const { snapshot, fingerprint } = record;
  const fileById = new Map(fingerprint.files.map((file) => [file.fileId, file] as const));
  const fileIds = new Set(fileById.keys());

  const analysis = snapshot.analysis;
  if (analysis == null) return false;
  const chapterIds = new Set(analysis.chapters.map((chapter) => chapter.id));
  const findingIds = new Set(analysis.findings.map((finding) => finding.id));
  if (chapterIds.size !== analysis.chapters.length || findingIds.size !== analysis.findings.length) return false;
  if (!recordKeysBelongTo(snapshot.acceptedFindingComments, findingIds)
    || !recordKeysBelongTo(snapshot.findingStatuses, findingIds)
    || !recordKeysBelongTo(snapshot.reviewedChapters, chapterIds)) return false;

  const map = snapshot.map;
  if (map != null) {
    const mapChapterIds = new Set(map.chapters.map((chapter) => chapter.id));
    const visitIds = new Set(map.chapters.flatMap((chapter) => chapter.visits.map((visit) => visit.id)));
    if (!recordKeysBelongTo(snapshot.reviewedVisits, visitIds)
      || map.changeUnits.some((unit) => !fileIds.has(unit.fileId))
      || map.chapters.some((chapter) => chapter.fileIds.some((fileId) => !fileIds.has(fileId)))) return false;
    if (snapshot.activeVisitId != null && !visitIds.has(snapshot.activeVisitId)) return false;
    if (snapshot.activeInsight?.type === "chapter" && !mapChapterIds.has(snapshot.activeInsight.id ?? "")) return false;
  } else if (snapshot.reviewedVisits != null || snapshot.activeVisitId != null) {
    return false;
  }

  for (const chapter of analysis.chapters) {
    if (chapter.fileIds.some((fileId) => !fileIds.has(fileId))) return false;
    if (chapter.findingIds.some((findingId) => !findingIds.has(findingId))) return false;
    for (const range of chapter.ranges) {
      const file = fileById.get(range.fileId);
      if (file == null || !chapter.fileIds.includes(range.fileId)) return false;
      const paths = new Set([file.path, file.displayPath, file.oldPath, file.newPath].filter(isNonemptyString));
      if (!paths.has(range.path)) return false;
    }
  }
  for (const finding of analysis.findings) {
    for (const location of finding.locations) {
      const file = fileById.get(location.fileId);
      if (file == null || location.path !== file.path) return false;
    }
  }
  if (analysis.approvalPacket.reviewedChapters.some((id) => !chapterIds.has(id))) return false;
  if (analysis.approvalPacket.unresolvedFindings.some((id) => !findingIds.has(id))) return false;

  const activeInsight = snapshot.activeInsight;
  if (activeInsight?.type === "chapter") {
    const activeChapterIds = map == null ? chapterIds : new Set(map.chapters.map((chapter) => chapter.id));
    if (!activeChapterIds.has(activeInsight.id ?? "")) return false;
  }
  if (activeInsight?.type === "finding" && !findingIds.has(activeInsight.id ?? "")) return false;
  if (activeInsight?.type === "comment") {
    const commentIds = new Set((snapshot.comments ?? []).map((comment) => comment.id));
    if (!commentIds.has(activeInsight.id ?? "")) return false;
  }
  return true;
}

type ReviewSessionRecordContent = Pick<
  ReviewSessionRecord,
  "sourceKey" | "fingerprint" | "snapshot" | "updatedAt"
>;

function hasValidSessionRecordContent(value: Record<string, unknown>): value is Record<string, unknown> & ReviewSessionRecordContent {
  if (!isNonemptyString(value.sourceKey)) return false;
  if (!isReviewFingerprint(value.fingerprint) || value.fingerprint.sourceKey !== value.sourceKey) return false;
  if (!isReviewSnapshot(value.snapshot)) return false;
  if (value.snapshot.githubPublishIntent != null
    && value.snapshot.githubPublishIntent.source.sourceKey !== value.sourceKey) return false;
  return isNonemptyString(value.updatedAt)
    && hasValidSessionReferences(value as unknown as ReviewSessionRecordContent);
}

function isSessionRecord(value: unknown): value is ReviewSessionRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "version", "revision", "recordHash", "sourceKey", "fingerprint", "snapshot", "updatedAt",
  ])) return false;
  if (value.version !== REVIEW_SESSION_RECORD_VERSION
    || !isNonnegativeInteger(value.revision)
    || typeof value.recordHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.recordHash)
    || !hasValidSessionRecordContent(value)) return false;
  const record = value as unknown as ReviewSessionRecord;
  return record.recordHash === reviewSessionRecordHash(record);
}

function reviewSessionRecordHash(record: Omit<ReviewSessionRecord, "recordHash"> | ReviewSessionRecord): string {
  const { recordHash: _ignored, ...hashInput } = record as ReviewSessionRecord;
  return sha256(stableJson(hashInput));
}

function withReviewSessionRecordHash(record: Omit<ReviewSessionRecord, "recordHash">): ReviewSessionRecord {
  return { ...record, recordHash: reviewSessionRecordHash(record) };
}

function migrateLegacyReviewSessionRecord(value: unknown): ReviewSessionRecord | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "version", "sourceKey", "fingerprint", "snapshot", "updatedAt",
  ]) || value.version !== 1 || !hasValidSessionRecordContent(value)) return null;
  return withReviewSessionRecordHash({
    version: REVIEW_SESSION_RECORD_VERSION,
    revision: 0,
    sourceKey: value.sourceKey,
    fingerprint: value.fingerprint,
    snapshot: value.snapshot,
    updatedAt: value.updatedAt,
  });
}

function parseReviewSessionRecord(value: unknown): ReviewSessionRecord | null {
  if (isSessionRecord(value)) return value;
  return migrateLegacyReviewSessionRecord(value);
}

export function reviewSessionRecordState(
  record: ReviewSessionRecord | null | undefined,
): ReviewSessionRecordState | null {
  return record == null ? null : { revision: record.revision, recordHash: record.recordHash };
}

export function reviewSessionRecoveryPath(storagePath: string, record: ReviewSessionRecord): string {
  return join(dirname(storagePath), "recovery", `${record.recordHash}.json`);
}

export interface LoadReviewSessionDependencies {
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

export async function loadReviewSession(
  storagePath: string,
  dependencies: LoadReviewSessionDependencies = {},
): Promise<ReviewSessionRecord | null> {
  let source: string;
  try {
    source = await (dependencies.readFile ?? readFile)(storagePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new ReviewSessionLoadError(`Could not read saved review session metadata at ${storagePath}.`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ReviewSessionLoadError(`Saved review session metadata at ${storagePath} is corrupt JSON.`, { cause: error });
  }
  const record = parseReviewSessionRecord(parsed);
  if (record == null) {
    throw new ReviewSessionLoadError(`Saved review session metadata at ${storagePath} is invalid or incompatible.`);
  }
  return record;
}

export async function resetReviewSession(storagePath: string): Promise<void> {
  await withReviewSessionTransaction(storagePath, async () => {
    await rm(dirname(storagePath), { recursive: true, force: true });
  });
}

interface ReviewSessionFileHandle {
  writeFile(contents: string, encoding?: "utf8"): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ReviewSessionFileDependencies {
  mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>;
  open?: (path: string, flags: string, mode?: number) => Promise<ReviewSessionFileHandle>;
  rename?: (from: string, to: string) => Promise<void>;
  rm?: (path: string, options: { force: true }) => Promise<void>;
}

export async function writeReviewSessionFileDurably(
  storagePath: string,
  contents: string,
  dependencies: ReviewSessionFileDependencies = {},
): Promise<void> {
  const parent = dirname(storagePath);
  const makeDirectory = dependencies.mkdir ?? mkdir;
  const openFile = dependencies.open ?? (open as unknown as NonNullable<ReviewSessionFileDependencies["open"]>);
  const renameFile = dependencies.rename ?? rename;
  const removeFile = dependencies.rm ?? rm;
  await makeDirectory(parent, { recursive: true });

  const tempPath = `${storagePath}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const tempHandle = await openFile(tempPath, "wx", 0o600);
    try {
      await tempHandle.writeFile(contents, "utf8");
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }

    await renameFile(tempPath, storagePath);
    renamed = true;

    const parentHandle = await openFile(parent, "r");
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch (error) {
    if (!renamed) {
      try {
        await removeFile(tempPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Could not durably write ${storagePath}, and its temporary file could not be removed.`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

export interface SaveReviewSessionOptions {
  expectedRecordState?: ReviewSessionRecordState | null;
  publishIntentTransition?: GitHubPublishIntentTransition;
}

function sameReviewSessionRecordState(
  record: ReviewSessionRecord | null,
  expected: ReviewSessionRecordState | null,
): boolean {
  if (record == null || expected == null) return record == null && expected == null;
  return record.revision === expected.revision && record.recordHash === expected.recordHash;
}

function samePublishIntentState(
  left: GitHubReviewPublishIntent | null,
  right: GitHubReviewPublishIntent | null,
): boolean {
  return stableJson(left) === stableJson(right);
}

function mergeReviewSessionRecordForSave(
  current: ReviewSessionRecord | null,
  record: ReviewSessionRecord,
  expectedRecordState: ReviewSessionRecordState | null | undefined,
  transition: GitHubPublishIntentTransition | undefined,
): ReviewSessionRecord {
  if (!isSessionRecord(record)) {
    throw new ReviewSessionLoadError("Refusing to save invalid or incompatible review session metadata.");
  }
  if (current != null && current.sourceKey !== record.sourceKey) {
    throw new ReviewSessionConflictError("The saved review source changed while this session was active.");
  }
  const transitionRecordState = transition?.expectedRecordState;
  if (transition != null && transitionRecordState === undefined) {
    throw new ReviewSessionConflictError("The GitHub publish transition is missing its expected session record revision and hash.");
  }
  if (expectedRecordState !== undefined
    && transitionRecordState !== undefined
    && stableJson(expectedRecordState) !== stableJson(transitionRecordState)) {
    throw new ReviewSessionConflictError("The GitHub publish transition does not match the expected session record state.");
  }
  const selectedExpectedState = expectedRecordState ?? transitionRecordState;
  if (selectedExpectedState === undefined && current != null) {
    throw new ReviewSessionConflictError(
      "The review session already exists; its expected record revision and hash are required before saving.",
    );
  }
  if (selectedExpectedState !== undefined && !sameReviewSessionRecordState(current, selectedExpectedState)) {
    throw new ReviewSessionConflictError(
      "The review session record changed in another process; the revision/hash compare-and-swap was rejected.",
    );
  }

  const currentIntent = current?.snapshot.githubPublishIntent ?? null;
  const fingerprintChanged = current != null && current.fingerprint.hash !== record.fingerprint.hash;
  if (fingerprintChanged && currentIntent?.status === "confirmed"
    && (transition == null
      || !samePublishIntentState(transition.expected, currentIntent)
      || transition.next !== null)) {
    throw new ReviewSessionConflictError(
      "A confirmed publish intent from a stale diff must be retired with an explicit revision/hash compare-and-swap transition.",
    );
  }
  let selectedIntent = currentIntent;
  if (transition != null) {
    if ((transition.expected != null && !isPublishIntent(transition.expected))
      || (transition.next != null && !isPublishIntent(transition.next))) {
      throw new ReviewSessionConflictError("The requested GitHub publish intent transition is invalid.");
    }
    if (!samePublishIntentState(currentIntent, transition.expected)) {
      throw new ReviewSessionConflictError(
        "The GitHub publish intent changed in another process; the compare-and-swap transition was rejected.",
      );
    }
    const incomingIntent = record.snapshot.githubPublishIntent ?? null;
    if (!samePublishIntentState(incomingIntent, transition.next)) {
      throw new ReviewSessionConflictError("The saved snapshot does not match its GitHub publish intent transition.");
    }
    selectedIntent = transition.next;
  }

  const authoritativePublished = new Map<string, DiffReviewComment>();
  if (!fingerprintChanged) {
    for (const comment of publishedCommentsFromSnapshot(current?.snapshot)) {
      authoritativePublished.set(comment.id, comment);
    }
  }
  for (const comment of publishedCommentsFromConfirmedIntent(selectedIntent)) {
    authoritativePublished.set(comment.id, comment);
  }
  const withoutIntent = snapshotWithoutPublishIntent(record.snapshot);
  const withPublished = mergeAuthoritativePublishedComments(withoutIntent, authoritativePublished.values());
  const snapshot = selectedIntent == null
    ? withPublished
    : { ...withPublished, githubPublishIntent: selectedIntent };
  const merged = withReviewSessionRecordHash({
    ...record,
    revision: (current?.revision ?? 0) + 1,
    snapshot,
  });
  if (!isSessionRecord(merged)) {
    throw new ReviewSessionLoadError("Refusing to save invalid or incompatible review session metadata.");
  }
  return merged;
}

export interface ReviewSessionLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  lockfPath?: string;
  shlockPath?: string;
  onLockfHolderReady?: (pid: number) => void;
}

type ReviewSessionLockRelease = () => Promise<void>;

interface LockfLease {
  holderPid: number;
  lost: Promise<Error>;
  release: ReviewSessionLockRelease;
}

type ReviewSessionLockAttempt =
  | { status: "acquired"; lease: LockfLease }
  | { status: "busy" | "unavailable" };

interface ReviewSessionLockHandle {
  lost: Promise<Error>;
  release: ReviewSessionLockRelease;
}

type ShlockAttempt =
  | { status: "acquired"; release: ReviewSessionLockRelease }
  | { status: "busy" | "unavailable" };

function runShlock(shlockPath: string, lockPath: string): Promise<ShlockAttempt> {
  return new Promise((resolveShlock, rejectShlock) => {
    execFile(shlockPath, ["-p", String(process.pid), "-f", lockPath], async (error) => {
      if (error == null) {
        try {
          resolveShlock({ status: "acquired", release: await createShlockRelease(lockPath) });
        } catch (releaseError) {
          rejectShlock(releaseError);
        }
        return;
      }
      if (error.code === "ENOENT") {
        resolveShlock({ status: "unavailable" });
        return;
      }
      if (error.code === 1) {
        resolveShlock({ status: "busy" });
        return;
      }
      rejectShlock(error);
    });
  });
}

async function createShlockRelease(lockPath: string): Promise<ReviewSessionLockRelease> {
  const acquiredStat = await stat(lockPath);
  let released = false;
  return async (): Promise<void> => {
    if (released) return;
    released = true;
    let owner: string;
    let currentStat: Awaited<ReturnType<typeof stat>>;
    try {
      owner = await readFile(lockPath, "utf8");
      currentStat = await stat(lockPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (owner.trim() === String(process.pid)
      && currentStat.dev === acquiredStat.dev
      && currentStat.ino === acquiredStat.ino) {
      await rm(lockPath, { force: true });
    }
  };
}

function lockfHolderExitError(
  result: { code: number | null; signal: NodeJS.Signals | null },
  stderr: string,
): Error {
  return new Error(
    `The lockf review session holder exited unexpectedly with ${result.code ?? result.signal ?? "an unknown status"}: ${stderr.trim()}`,
  );
}

function runLockf(lockfPath: string, lockPath: string): Promise<ReviewSessionLockAttempt> {
  const holderSource = "process.stdin.once('end',()=>process.exit(0));process.stdin.resume();process.stdout.write('lock-acquired:'+process.pid+'\\n');";
  const child = spawn(lockfPath, [
    "-k", "-s", "-w", "-t", "0", lockPath,
    process.execPath, "--input-type=module", "--eval", holderSource,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  let acquisitionSettled = false;
  let acquired = false;
  let releaseRequested = false;
  let unexpectedExit: Error | null = null;
  let resolveLost: (error: Error) => void = () => {};
  const lost = new Promise<Error>((resolve) => { resolveLost = resolve; });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.on("error", () => undefined);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClosed) => {
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
  });

  return new Promise((resolveAttempt, rejectAttempt) => {
    child.once("error", (error) => {
      if (acquisitionSettled) return;
      acquisitionSettled = true;
      if (errorCode(error) === "ENOENT") {
        resolveAttempt({ status: "unavailable" });
      } else {
        rejectAttempt(error);
      }
    });
    child.stdout.on("data", (chunk) => {
      if (acquisitionSettled) return;
      stdout += String(chunk);
      const ready = /lock-acquired:(\d+)\n/.exec(stdout);
      if (ready == null) return;
      const holderPid = Number.parseInt(ready[1]!, 10);
      if (!Number.isSafeInteger(holderPid) || holderPid <= 0) return;
      acquisitionSettled = true;
      acquired = true;
      let released = false;
      resolveAttempt({
        status: "acquired",
        lease: {
          holderPid,
          lost,
          release: async () => {
            if (released) return;
            released = true;
            releaseRequested = true;
            if (child.exitCode == null && child.signalCode == null) child.stdin.end();
            const result = await closed;
            if (unexpectedExit != null) throw unexpectedExit;
            if (result.code !== 0) throw lockfHolderExitError(result, stderr);
          },
        },
      });
    });
    void closed.then((result) => {
      if (acquired) {
        if (!releaseRequested) {
          unexpectedExit = lockfHolderExitError(result, stderr);
          resolveLost(unexpectedExit);
        }
        return;
      }
      if (acquisitionSettled) return;
      acquisitionSettled = true;
      if (result.code === 75) {
        resolveAttempt({ status: "busy" });
        return;
      }
      rejectAttempt(new Error(
        `Could not acquire the review session lock with lockf (exit ${result.code ?? result.signal ?? "unknown"}): ${stderr.trim()}`,
      ));
    });
  });
}

async function releaseAfterLockAcquisitionFailure(
  lease: LockfLease,
  primaryError: unknown,
): Promise<never> {
  try {
    await lease.release();
  } catch (releaseError) {
    throw new AggregateError(
      [primaryError, releaseError],
      "The review session lock could not be acquired, and its lockf holder could not be released.",
      { cause: primaryError },
    );
  }
  throw primaryError;
}

async function settleShlockAfterLockfLoss(
  attempt: Promise<ShlockAttempt>,
  lockfError: Error,
): Promise<never> {
  try {
    const outcome = await attempt;
    if (outcome.status === "acquired") await outcome.release();
  } catch (shlockError) {
    throw new AggregateError(
      [lockfError, shlockError],
      "The lockf review session holder was lost, and its in-flight shlock operation could not be settled safely.",
      { cause: lockfError },
    );
  }
  throw lockfError;
}

async function acquireReviewSessionLockHandle(
  storagePath: string,
  options: ReviewSessionLockOptions,
): Promise<ReviewSessionLockHandle> {
  const lockPath = `${dirname(storagePath)}.lock`;
  const pidGuardPath = `${lockPath}.pid`;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const retryDelayMs = options.retryDelayMs ?? 20;
  const lockfPath = options.lockfPath ?? "/usr/bin/lockf";
  const shlockPath = options.shlockPath ?? "/usr/bin/shlock";
  await mkdir(dirname(lockPath), { recursive: true });

  let lease: LockfLease;
  while (true) {
    const attempt = await runLockf(lockfPath, lockPath);
    if (attempt.status === "unavailable") {
      throw new ReviewSessionConflictError(
        "lockf is unavailable, so the review session cannot be updated safely across processes.",
      );
    }
    if (attempt.status === "acquired") {
      lease = attempt.lease;
      break;
    }
    if (Date.now() >= deadline) {
      throw new ReviewSessionConflictError(
        "Timed out waiting for another process to finish updating this review session lock.",
      );
    }
    await delay(retryDelayMs);
  }

  let shlockRelease: ReviewSessionLockRelease;
  try {
    while (true) {
      const shlockAttempt = runShlock(shlockPath, pidGuardPath);
      const outcome = await Promise.race([
        shlockAttempt.then((attempt) => ({ type: "shlock" as const, attempt })),
        lease.lost.then((error) => ({ type: "lost" as const, error })),
      ]);
      if (outcome.type === "lost") {
        return await settleShlockAfterLockfLoss(shlockAttempt, outcome.error);
      }
      if (outcome.attempt.status === "unavailable") {
        throw new ReviewSessionConflictError(
          "shlock is unavailable, so the review session cannot be updated safely across processes.",
        );
      }
      if (outcome.attempt.status === "acquired") {
        shlockRelease = outcome.attempt.release;
        break;
      }
      if (Date.now() >= deadline) {
        throw new ReviewSessionConflictError(
          "Timed out waiting for another process to finish updating this review session PID guard.",
        );
      }
      const wait = await Promise.race([
        delay(retryDelayMs).then(() => null),
        lease.lost,
      ]);
      if (wait instanceof Error) throw wait;
    }
  } catch (error) {
    return await releaseAfterLockAcquisitionFailure(lease, error);
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    let shlockError: unknown = null;
    try {
      await shlockRelease();
    } catch (error) {
      shlockError = error;
    }
    try {
      await lease.release();
    } catch (lockfError) {
      if (shlockError != null) {
        throw new AggregateError(
          [shlockError, lockfError],
          "Neither the review session PID guard nor its lockf holder could be released.",
          { cause: shlockError },
        );
      }
      throw lockfError;
    }
    if (shlockError != null) throw shlockError;
  };

  try {
    options.onLockfHolderReady?.(lease.holderPid);
  } catch (error) {
    try {
      await release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "The review session lock observer failed, and the acquired lock could not be released.",
        { cause: error },
      );
    }
    throw error;
  }
  return { lost: lease.lost, release };
}

export async function acquireReviewSessionLock(
  storagePath: string,
  options: ReviewSessionLockOptions = {},
): Promise<() => Promise<void>> {
  return (await acquireReviewSessionLockHandle(storagePath, options)).release;
}

async function runReviewSessionTransactionTask<T>(
  task: () => Promise<T>,
  lost: Promise<Error>,
): Promise<T> {
  const taskOutcome = Promise.resolve().then(task).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  const first = await Promise.race([
    taskOutcome.then((outcome) => ({ source: "task" as const, outcome })),
    lost.then((error) => ({ source: "lost" as const, error })),
  ]);
  if (first.source === "task") {
    if (first.outcome.status === "rejected") throw first.outcome.error;
    return first.outcome.value;
  }

  const finalTaskOutcome = await taskOutcome;
  if (finalTaskOutcome.status === "rejected") {
    throw new AggregateError(
      [first.error, finalTaskOutcome.error],
      "The review session lock was lost while its transaction was active, and the transaction also failed.",
      { cause: first.error },
    );
  }
  throw first.error;
}

export async function withReviewSessionTransaction<T>(
  storagePath: string,
  task: () => Promise<T>,
  lockOptions: ReviewSessionLockOptions = {},
): Promise<T> {
  const handle = await acquireReviewSessionLockHandle(storagePath, lockOptions);
  let primaryError: unknown = null;
  try {
    return await runReviewSessionTransactionTask(task, handle.lost);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.release();
    } catch (releaseError) {
      if (primaryError == null) throw releaseError;
      throw new AggregateError(
        [primaryError, releaseError],
        `The review session transaction failed: ${errorMessage(primaryError)} Its interprocess lock also could not be released.`,
        { cause: primaryError },
      );
    }
  }
}

export async function saveReviewSession(
  storagePath: string,
  record: ReviewSessionRecord,
  options: SaveReviewSessionOptions = {},
): Promise<ReviewSessionRecord> {
  return await withReviewSessionTransaction(storagePath, async () => {
    const current = await loadReviewSession(storagePath);
    const merged = mergeReviewSessionRecordForSave(
      current,
      record,
      options.expectedRecordState,
      options.publishIntentTransition,
    );
    if (current != null && current.fingerprint.hash !== merged.fingerprint.hash) {
      await writeReviewSessionFileDurably(
        reviewSessionRecoveryPath(storagePath, current),
        `${JSON.stringify(current, null, 2)}\n`,
      );
    }
    await writeReviewSessionFileDurably(storagePath, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  });
}

export function buildReviewSessionRecord(options: {
  sourceKey: string;
  fingerprint: ReviewDiffFingerprint;
  analysis: ReviewAnalysis;
  snapshot?: ReviewSessionSnapshot | null;
}): ReviewSessionRecord {
  const updatedAt = new Date().toISOString();
  return withReviewSessionRecordHash({
    version: REVIEW_SESSION_RECORD_VERSION,
    revision: 0,
    sourceKey: options.sourceKey,
    fingerprint: options.fingerprint,
    snapshot: {
      ...(options.snapshot ?? {}),
      analysis: options.analysis,
      updatedAt,
    },
    updatedAt,
  });
}

export function reviveSessionAnalysis(snapshot: ReviewSessionSnapshot | null | undefined, dataset: ReviewDataset): ReviewAnalysis | null {
  const analysis = snapshot?.analysis;
  if (!analysis) return null;

  try {
    const parsed = parseReviewAnalysisJson(JSON.stringify({
      chapters: analysis.chapters,
      findings: analysis.findings,
      approvalPacket: analysis.approvalPacket,
    }), dataset);
    return {
      ...parsed,
      status: analysis.status,
      message: analysis.message,
    };
  } catch {
    return null;
  }
}

function comparisonForComment(file: ReviewFile, comment: DiffReviewComment) {
  if (comment.scope === "git-diff") return file.inGitDiff ? file.gitDiff : null;
  if (comment.scope === "last-commit") return file.inLastCommit ? file.lastCommit : null;
  if (comment.scope === "commit") return comment.commitSha == null ? null : file.commitComparisons[comment.commitSha] ?? null;
  return null;
}

function fileSupportsComment(file: ReviewFile, comment: DiffReviewComment, commitShas: ReadonlySet<string>): boolean {
  if (comment.scope === "all-files") {
    return file.hasWorkingTreeFile && comment.side === "file";
  }
  if (comment.scope === "commit" && (comment.commitSha == null || !commitShas.has(comment.commitSha))) {
    return false;
  }
  const comparison = comparisonForComment(file, comment);
  if (comparison == null) return false;
  if (comment.side === "file") return true;
  if (comment.startLine == null) return false;
  const endLine = comment.endLine ?? comment.startLine;
  const ranges = comment.side === "original"
    ? comparison.commentableOriginalLines ?? []
    : comparison.commentableModifiedLines ?? [];
  return ranges.some((range) => comment.startLine! >= range.start && endLine <= range.end);
}

function datasetSupportsScope(
  dataset: ReviewDataset,
  scope: ReviewSessionSnapshot["currentScope"],
  selectedCommitSha: string | null | undefined,
): boolean {
  if (scope == null) return false;
  if (scope === "git-diff") return dataset.files.some((file) => file.inGitDiff && file.gitDiff != null);
  if (scope === "last-commit") return dataset.files.some((file) => file.inLastCommit && file.lastCommit != null);
  if (scope === "all-files") return dataset.files.some((file) => file.hasWorkingTreeFile);
  return selectedCommitSha != null
    && dataset.commits.some((commit) => commit.sha === selectedCommitSha)
    && dataset.files.some((file) => file.commitComparisons[selectedCommitSha] != null);
}

function uniqueFingerprintFilesByPath(files: readonly ReviewFileFingerprint[]): Map<string, ReviewFileFingerprint> {
  const grouped = new Map<string, ReviewFileFingerprint[]>();
  for (const file of files) {
    const matches = grouped.get(file.path) ?? [];
    matches.push(file);
    grouped.set(file.path, matches);
  }
  return new Map(
    [...grouped.entries()]
      .filter((entry): entry is [string, [ReviewFileFingerprint]] => entry[1].length === 1)
      .map(([path, [file]]) => [path, file]),
  );
}

function unchangedFileIdMap(
  previousFingerprint: ReviewDiffFingerprint,
  currentFingerprint: ReviewDiffFingerprint,
  dataset: ReviewDataset,
): Map<string, string> {
  const previousByPath = uniqueFingerprintFilesByPath(previousFingerprint.files);
  const currentByPath = uniqueFingerprintFilesByPath(currentFingerprint.files);
  const currentDatasetFileIds = new Set(dataset.files.map((file) => file.id));
  const result = new Map<string, string>();
  for (const [path, previous] of previousByPath) {
    const current = currentByPath.get(path);
    if (current == null
      || current.patchHash !== previous.patchHash
      || !currentDatasetFileIds.has(current.fileId)) continue;
    result.set(previous.fileId, current.fileId);
  }
  return result;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function reconcileHumanSnapshot(options: {
  snapshot: ReviewSessionSnapshot;
  dataset: ReviewDataset;
  fileIdMap: ReadonlyMap<string, string>;
  previousFileCount: number;
  currentFileCount: number;
  retireConfirmedIntent: boolean;
}): {
  snapshot: ReviewSessionSnapshot;
  counts: ReviewSessionReconciliationCounts;
  confirmedPublishIntentToRetire: GitHubReviewPublishIntent | null;
} {
  const { dataset, fileIdMap } = options;
  const intent = options.snapshot.githubPublishIntent ?? null;
  const confirmedPublishIntentToRetire = options.retireConfirmedIntent && intent?.status === "confirmed"
    ? intent
    : null;
  const sourceSnapshot = confirmedPublishIntentToRetire == null
    ? options.snapshot
    : mergeAuthoritativePublishedComments(
        snapshotWithoutPublishIntent(options.snapshot),
        publishedCommentsFromConfirmedIntent(confirmedPublishIntentToRetire),
      );
  const currentFileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const commitShas = new Set(dataset.commits.map((commit) => commit.sha));
  const comments: DiffReviewComment[] = [];
  for (const comment of sourceSnapshot.comments ?? []) {
    const currentFileId = fileIdMap.get(comment.fileId);
    const currentFile = currentFileId == null ? null : currentFileById.get(currentFileId) ?? null;
    const remapped = currentFileId == null ? null : { ...comment, fileId: currentFileId };
    if (currentFile == null || remapped == null || !fileSupportsComment(currentFile, remapped, commitShas)) continue;
    comments.push(remapped);
  }

  const reviewedFiles: Record<string, boolean> = {};
  for (const [previousFileId, reviewed] of Object.entries(sourceSnapshot.reviewedFiles ?? {})) {
    const currentFileId = fileIdMap.get(previousFileId);
    if (currentFileId != null && currentFileById.has(currentFileId)) reviewedFiles[currentFileId] = reviewed;
  }

  const snapshot: ReviewSessionSnapshot = {};
  if (sourceSnapshot.overallComment != null) snapshot.overallComment = sourceSnapshot.overallComment;
  if (sourceSnapshot.comments != null || confirmedPublishIntentToRetire != null) snapshot.comments = comments;
  if (sourceSnapshot.reviewedFiles != null) snapshot.reviewedFiles = reviewedFiles;

  const activeFileId = sourceSnapshot.activeFileId == null ? sourceSnapshot.activeFileId : fileIdMap.get(sourceSnapshot.activeFileId);
  if (activeFileId !== undefined) snapshot.activeFileId = activeFileId ?? null;
  if (sourceSnapshot.activeSidebarTab != null) snapshot.activeSidebarTab = sourceSnapshot.activeSidebarTab;

  const selectedCommitSha = sourceSnapshot.selectedCommitSha;
  if (selectedCommitSha === null || (selectedCommitSha != null && commitShas.has(selectedCommitSha))) {
    snapshot.selectedCommitSha = selectedCommitSha;
  }
  if (datasetSupportsScope(dataset, sourceSnapshot.currentScope, snapshot.selectedCommitSha)) {
    snapshot.currentScope = sourceSnapshot.currentScope;
  }

  const retainedCommentIds = new Set(comments.map((comment) => comment.id));
  if (sourceSnapshot.activeInsight?.type === "default"
    || (sourceSnapshot.activeInsight?.type === "comment"
      && sourceSnapshot.activeInsight.id != null
      && retainedCommentIds.has(sourceSnapshot.activeInsight.id))) {
    snapshot.activeInsight = sourceSnapshot.activeInsight;
  }
  if (sourceSnapshot.hideUnchanged != null) snapshot.hideUnchanged = sourceSnapshot.hideUnchanged;
  if (sourceSnapshot.wrapLines != null) snapshot.wrapLines = sourceSnapshot.wrapLines;
  if (sourceSnapshot.sidebarCollapsed != null) snapshot.sidebarCollapsed = sourceSnapshot.sidebarCollapsed;
  if (confirmedPublishIntentToRetire == null && intent != null) snapshot.githubPublishIntent = intent;

  const previousComments = sourceSnapshot.comments?.length ?? 0;
  const previousReviewedFiles = Object.values(sourceSnapshot.reviewedFiles ?? {}).filter((reviewed) => reviewed === true).length;
  const retainedReviewedFiles = Object.values(reviewedFiles).filter((reviewed) => reviewed === true).length;
  return {
    snapshot,
    counts: {
      previousFileCount: options.previousFileCount,
      currentFileCount: options.currentFileCount,
      unchangedFileCount: fileIdMap.size,
      retainedCommentCount: comments.length,
      droppedCommentCount: previousComments - comments.length,
      retainedReviewedFileCount: retainedReviewedFiles,
      droppedReviewedFileCount: previousReviewedFiles - retainedReviewedFiles,
    },
    confirmedPublishIntentToRetire,
  };
}

export function resolveReviewSession(options: {
  stored: ReviewSessionRecord | null;
  sourceKey: string;
  currentFingerprint: ReviewDiffFingerprint;
  dataset: ReviewDataset;
}): ReviewSessionResolution {
  const { stored, sourceKey, currentFingerprint, dataset } = options;
  if (stored == null || stored.sourceKey !== sourceKey) {
    return {
      status: "new",
      message: "No saved review session.",
      snapshot: null,
      analysis: null,
      updatedAt: null,
      reconciliation: null,
      confirmedPublishIntentToRetire: null,
    };
  }

  const analysis = stored.fingerprint.hash === currentFingerprint.hash
    ? reviveSessionAnalysis(stored.snapshot, dataset)
    : null;

  if (stored.fingerprint.hash === currentFingerprint.hash && analysis != null) {
    return {
      status: "restored",
      message: "Review session restored.",
      snapshot: stored.snapshot,
      analysis,
      updatedAt: stored.updatedAt,
      reconciliation: null,
      confirmedPublishIntentToRetire: null,
    };
  }

  if (stored.fingerprint.hash === currentFingerprint.hash) {
    const currentFileIds = new Map(dataset.files.map((file) => [file.id, file.id] as const));
    const refreshed = reconcileHumanSnapshot({
      snapshot: stored.snapshot,
      dataset,
      fileIdMap: currentFileIds,
      previousFileCount: stored.fingerprint.fileCount,
      currentFileCount: currentFingerprint.fileCount,
      retireConfirmedIntent: false,
    });
    return {
      status: "refreshed",
      message: "Saved review map was invalid, so it was refreshed.",
      snapshot: refreshed.snapshot,
      analysis: null,
      updatedAt: stored.updatedAt,
      reconciliation: refreshed.counts,
      confirmedPublishIntentToRetire: null,
    };
  }

  const reconciled = reconcileHumanSnapshot({
    snapshot: stored.snapshot,
    dataset,
    fileIdMap: unchangedFileIdMap(stored.fingerprint, currentFingerprint, dataset),
    previousFileCount: stored.fingerprint.fileCount,
    currentFileCount: currentFingerprint.fileCount,
    retireConfirmedIntent: true,
  });
  const counts = reconciled.counts;
  return {
    status: "stale",
    message: `Diff changed since the last review. Reconciled ${plural(counts.unchangedFileCount, "unchanged file")}; retained ${plural(counts.retainedCommentCount, "comment")} (${counts.droppedCommentCount} dropped) and ${plural(counts.retainedReviewedFileCount, "reviewed file")} (${counts.droppedReviewedFileCount} dropped). Generated analysis will refresh.`,
    snapshot: reconciled.snapshot,
    analysis: null,
    updatedAt: stored.updatedAt,
    reconciliation: counts,
    confirmedPublishIntentToRetire: reconciled.confirmedPublishIntentToRetire,
  };
}
