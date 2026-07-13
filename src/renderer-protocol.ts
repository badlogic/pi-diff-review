import type {
  AcceptedFindingComment,
  ApprovalPacket,
  DiffReviewComment,
  FindingStatusUpdate,
  ReviewCheckpointSessionPayload,
  ReviewCancelPayload,
  ReviewPublishPayload,
  ReviewRequestFilePayload,
  ReviewRunAiReviewPayload,
  ReviewRefreshGitHubContextPayload,
  ReviewOpenExternalUrlPayload,
  ReviewRendererSessionSnapshot,
  ReviewSaveSessionPayload,
  ReviewPublishGitHubReviewResultMessage,
  ReviewSubmitPayload,
} from "./types.js";
import { Buffer } from "node:buffer";

const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 100_000;
const MAX_ITEMS = 2_000;
const MAX_LINE = 10_000_000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_DEPTH = 16;
const MAX_MESSAGE_NODES = 50_000;
const INVALID = Symbol("invalid-renderer-value");

type PlainRecord = Record<string, unknown>;
type ReviewScope = "git-diff" | "last-commit" | "commit" | "all-files";
type Invalid = typeof INVALID;

export interface RendererProtocolFile {
  scopes: ReadonlySet<ReviewScope>;
  commitShas: ReadonlySet<string>;
}

export interface RendererProtocolContext {
  sessionId: string;
  capability: string;
  files: ReadonlyMap<string, RendererProtocolFile>;
  commitShas: ReadonlySet<string>;
  findingIds: ReadonlySet<string>;
  chapterIds: ReadonlySet<string>;
  visitIds?: ReadonlySet<string>;
}

export interface RendererReadyMessage {
  type: "renderer-ready";
}

export interface RendererBootedMessage {
  type: "renderer-booted";
}

export type DecodedRendererMessage =
  | RendererBootedMessage
  | ReviewSubmitPayload
  | ReviewCancelPayload
  | ReviewRequestFilePayload
  | ReviewPublishPayload
  | ReviewRunAiReviewPayload
  | ReviewRefreshGitHubContextPayload
  | ReviewOpenExternalUrlPayload
  | ReviewCheckpointSessionPayload
  | ReviewSaveSessionPayload;

function isRecord(value: unknown): value is PlainRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value: PlainRecord, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isWithinMessageBudget(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null || current.depth > MAX_MESSAGE_DEPTH || ++nodes > MAX_MESSAGE_NODES) return false;
    const item = current.value;
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8") + 2;
    } else if (typeof item === "number") {
      bytes += 24;
    } else if (typeof item === "boolean") {
      bytes += 5;
    } else if (item == null || item === undefined) {
      bytes += 4;
    } else if (typeof item === "object") {
      if (seen.has(item)) return false;
      seen.add(item);
      bytes += 2;
      const keys = Object.keys(item);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor == null || !("value" in descriptor)) return false;
        bytes += Buffer.byteLength(key, "utf8") + 4;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } else {
      return false;
    }
    if (bytes > MAX_MESSAGE_BYTES) return false;
  }

  return true;
}

function stringValue(value: unknown, maxLength = MAX_TEXT_LENGTH, nonEmpty = false): string | null {
  if (typeof value !== "string" || value.length > maxLength || (nonEmpty && value.length === 0)) return null;
  return value;
}

function idValue(value: unknown): string | null {
  return stringValue(value, MAX_ID_LENGTH, true);
}

function fileIdValue(value: unknown, context: RendererProtocolContext): string | null {
  return typeof value === "string" && value.length > 0 && context.files.has(value) ? value : null;
}

function nullableFileIdValue(value: unknown, context: RendererProtocolContext): string | null | Invalid {
  if (value === null) return null;
  return fileIdValue(value, context) ?? INVALID;
}

function nullableString(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null | Invalid {
  if (value === null) return null;
  return stringValue(value, maxLength) ?? INVALID;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) && value.length <= MAX_ITEMS ? value : null;
}

function positiveLine(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_LINE ? value : null;
}

function nullableLine(value: unknown): number | null | Invalid {
  if (value === null) return null;
  return positiveLine(value) ?? INVALID;
}

function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function decodeScope(value: unknown): ReviewScope | null {
  return enumValue(value, ["git-diff", "last-commit", "commit", "all-files"] as const);
}

function hasKnownFileScope(context: RendererProtocolContext, fileId: string, scope: ReviewScope, commitSha: string | undefined): boolean {
  const file = context.files.get(fileId);
  if (file == null || !file.scopes.has(scope)) return false;
  if (scope === "commit") {
    return commitSha != null && context.commitShas.has(commitSha) && file.commitShas.has(commitSha);
  }
  return commitSha == null;
}

function decodeComment(value: unknown, context: RendererProtocolContext): DiffReviewComment | null {
  if (!isRecord(value) || !hasKeys(value, ["id", "fileId", "scope", "side", "startLine", "endLine", "body"], ["commitSha", "status", "published", "publishedAt", "githubReviewId", "githubReviewUrl"])) return null;
  const id = idValue(value.id);
  const fileId = fileIdValue(value.fileId, context);
  const scope = decodeScope(value.scope);
  const side = enumValue(value.side, ["original", "modified", "file"] as const);
  const body = stringValue(value.body);
  const commitShaValue = Object.hasOwn(value, "commitSha") ? idValue(value.commitSha) : undefined;
  const statusValue = Object.hasOwn(value, "status") ? enumValue(value.status, ["staged", "published"] as const) : undefined;
  const published = Object.hasOwn(value, "published") ? value.published : undefined;
  const publishedAtValue = Object.hasOwn(value, "publishedAt") ? stringValue(value.publishedAt, MAX_ID_LENGTH) : undefined;
  const githubReviewId = Object.hasOwn(value, "githubReviewId") ? value.githubReviewId : undefined;
  const githubReviewUrl = Object.hasOwn(value, "githubReviewUrl") ? stringValue(value.githubReviewUrl, MAX_ID_LENGTH) : undefined;
  const startLine = nullableLine(value.startLine);
  const endLine = nullableLine(value.endLine);
  if (id == null || fileId == null || scope == null || side == null || body == null || startLine === INVALID || endLine === INVALID || commitShaValue === null || statusValue === null || publishedAtValue === null) return null;
  if (published !== undefined && typeof published !== "boolean") return null;
  if (githubReviewId !== undefined && (typeof githubReviewId !== "number" || !Number.isSafeInteger(githubReviewId) || githubReviewId <= 0)) return null;
  if (githubReviewUrl === null) return null;
  if (!hasKnownFileScope(context, fileId, scope, commitShaValue)) return null;
  if (side === "file") {
    if (startLine !== null || endLine !== null) return null;
  } else if (startLine == null || (endLine != null && endLine < startLine)) {
    return null;
  }
  return {
    id,
    fileId,
    scope,
    commitSha: commitShaValue,
    side,
    startLine,
    endLine,
    body,
    status: statusValue,
    published,
    publishedAt: publishedAtValue,
    githubReviewId: typeof githubReviewId === "number" ? githubReviewId : undefined,
    githubReviewUrl,
  };
}

function decodeComments(value: unknown, context: RendererProtocolContext): DiffReviewComment[] | null {
  const items = arrayValue(value);
  if (items == null) return null;
  const comments: DiffReviewComment[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    const comment = decodeComment(item, context);
    if (comment == null || ids.has(comment.id)) return null;
    ids.add(comment.id);
    comments.push(comment);
  }
  return comments;
}

function decodeAcceptedFindings(value: unknown, context: RendererProtocolContext): AcceptedFindingComment[] | null {
  const items = arrayValue(value);
  if (items == null) return null;
  const result: AcceptedFindingComment[] = [];
  const findingIds = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || !hasKeys(item, ["findingId", "body"])) return null;
    const findingId = idValue(item.findingId);
    const body = stringValue(item.body);
    if (findingId == null || body == null || !context.findingIds.has(findingId) || findingIds.has(findingId)) return null;
    findingIds.add(findingId);
    result.push({ findingId, body });
  }
  return result;
}

function decodeFindingStatuses(value: unknown, context: RendererProtocolContext): FindingStatusUpdate[] | null {
  const items = arrayValue(value);
  if (items == null) return null;
  const result: FindingStatusUpdate[] = [];
  const findingIds = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || !hasKeys(item, ["findingId", "status"])) return null;
    const findingId = idValue(item.findingId);
    const status = enumValue(item.status, ["new", "accepted-comment", "dismissed", "accepted-risk"] as const);
    if (findingId == null || status == null || !context.findingIds.has(findingId) || findingIds.has(findingId)) return null;
    findingIds.add(findingId);
    result.push({ findingId, status });
  }
  return result;
}

function decodeStringIds(value: unknown, known: ReadonlySet<string>): string[] | null {
  const items = arrayValue(value);
  if (items == null) return null;
  const result: string[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    const id = idValue(item);
    if (id == null || !known.has(id) || ids.has(id)) return null;
    ids.add(id);
    result.push(id);
  }
  return result;
}

function decodeStrings(value: unknown, unique = false): string[] | null {
  const items = arrayValue(value);
  if (items == null) return null;
  const result: string[] = [];
  const strings = new Set<string>();
  for (const item of items) {
    const decoded = stringValue(item);
    if (decoded == null || (unique && strings.has(decoded))) return null;
    strings.add(decoded);
    result.push(decoded);
  }
  return result;
}

function decodeIds(value: unknown): string[] | null {
  const items = arrayValue(value);
  if (items == null) return null;
  const result: string[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    const id = idValue(item);
    if (id == null || ids.has(id)) return null;
    ids.add(id);
    result.push(id);
  }
  return result;
}

function decodeApprovalPacket(value: unknown, context: RendererProtocolContext): ApprovalPacket | null {
  if (!isRecord(value) || !hasKeys(value, ["summary", "reviewedChapters", "acceptedRisks", "unresolvedFindings", "suggestedVerdict", "body"])) return null;
  const summary = stringValue(value.summary);
  const reviewedChapters = decodeStringIds(value.reviewedChapters, context.chapterIds);
  const acceptedRisks = decodeStrings(value.acceptedRisks);
  const unresolvedFindings = decodeStringIds(value.unresolvedFindings, context.findingIds);
  const suggestedVerdict = enumValue(value.suggestedVerdict, ["comment", "request-changes", "approve"] as const);
  const body = stringValue(value.body);
  if (summary == null || reviewedChapters == null || acceptedRisks == null || unresolvedFindings == null || suggestedVerdict == null || body == null) return null;
  return { summary, reviewedChapters, acceptedRisks, unresolvedFindings, suggestedVerdict, body };
}

function decodeSubmit(value: unknown, context: RendererProtocolContext): ReviewSubmitPayload | null {
  if (!isRecord(value) || !hasKeys(value, ["type", "overallComment", "comments", "acceptedFindings", "findingStatuses", "approvalPacket"]) || value.type !== "submit") return null;
  const overallComment = stringValue(value.overallComment);
  const comments = decodeComments(value.comments, context);
  const acceptedFindings = decodeAcceptedFindings(value.acceptedFindings, context);
  const findingStatuses = decodeFindingStatuses(value.findingStatuses, context);
  const approvalPacket = decodeApprovalPacket(value.approvalPacket, context);
  if (overallComment == null || comments == null || acceptedFindings == null || findingStatuses == null || approvalPacket == null) return null;
  return { type: "submit", overallComment, comments, acceptedFindings, findingStatuses, approvalPacket };
}

function decodeBooleanMap(value: unknown, known: ReadonlySet<string>): Record<string, boolean> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_ITEMS) return null;
  const result = nullRecord<boolean>();
  for (const [key, item] of Object.entries(value)) {
    if (!known.has(key) || typeof item !== "boolean") return null;
    result[key] = item;
  }
  return result;
}

function decodeStringMap(value: unknown, known: ReadonlySet<string>): Record<string, string> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_ITEMS) return null;
  const result = nullRecord<string>();
  for (const [key, item] of Object.entries(value)) {
    const decoded = stringValue(item);
    if (!known.has(key) || decoded == null) return null;
    result[key] = decoded;
  }
  return result;
}

function decodeSnapshot(value: unknown, context: RendererProtocolContext): ReviewRendererSessionSnapshot | null {
  if (!isRecord(value)) return null;
  const allowed = [
    "overallComment", "comments", "acceptedFindingComments", "findingStatuses", "reviewedFiles", "reviewedChapters", "reviewedVisits",
    "activeFileId", "activeVisitId", "activeSidebarTab", "currentScope", "selectedCommitSha", "activeInsight", "hideUnchanged", "wrapLines",
    "sidebarCollapsed", "aiReviewCompleted", "aiReviewStatus", "dismissedFindingLocationKeys", "updatedAt",
  ];
  if (!hasKeys(value, [], allowed)) return null;
  const snapshot: ReviewRendererSessionSnapshot = {};
  if (Object.hasOwn(value, "overallComment")) {
    const overallComment = stringValue(value.overallComment);
    if (overallComment == null) return null;
    snapshot.overallComment = overallComment;
  }
  if (Object.hasOwn(value, "comments")) {
    const comments = decodeComments(value.comments, context);
    if (comments == null) return null;
    snapshot.comments = comments;
  }
  if (Object.hasOwn(value, "acceptedFindingComments")) {
    const accepted = decodeStringMap(value.acceptedFindingComments, context.findingIds);
    if (accepted == null) return null;
    snapshot.acceptedFindingComments = accepted;
  }
  if (Object.hasOwn(value, "findingStatuses")) {
    if (!isRecord(value.findingStatuses)) return null;
    if (Object.keys(value.findingStatuses).length > MAX_ITEMS) return null;
    const statuses = nullRecord<"new" | "accepted-comment" | "dismissed" | "accepted-risk">();
    for (const [id, statusValue] of Object.entries(value.findingStatuses)) {
      const status = enumValue(statusValue, ["new", "accepted-comment", "dismissed", "accepted-risk"] as const);
      if (!context.findingIds.has(id) || status == null) return null;
      statuses[id] = status;
    }
    snapshot.findingStatuses = statuses;
  }
  if (Object.hasOwn(value, "reviewedFiles")) {
    const reviewedFiles = decodeBooleanMap(value.reviewedFiles, new Set(context.files.keys()));
    if (reviewedFiles == null) return null;
    snapshot.reviewedFiles = reviewedFiles;
  }
  if (Object.hasOwn(value, "reviewedChapters")) {
    const reviewedChapters = decodeBooleanMap(value.reviewedChapters, context.chapterIds);
    if (reviewedChapters == null) return null;
    snapshot.reviewedChapters = reviewedChapters;
  }
  if (Object.hasOwn(value, "reviewedVisits")) {
    const reviewedVisits = decodeBooleanMap(value.reviewedVisits, context.visitIds ?? new Set());
    if (reviewedVisits == null) return null;
    snapshot.reviewedVisits = reviewedVisits;
  }
  if (Object.hasOwn(value, "activeFileId")) {
    const activeFileId = nullableFileIdValue(value.activeFileId, context);
    if (activeFileId === INVALID) return null;
    snapshot.activeFileId = activeFileId;
  }
  if (Object.hasOwn(value, "activeVisitId")) {
    const activeVisitId = nullableString(value.activeVisitId, MAX_ID_LENGTH);
    if (activeVisitId === INVALID || (activeVisitId != null && !(context.visitIds ?? new Set()).has(activeVisitId))) return null;
    snapshot.activeVisitId = activeVisitId;
  }
  if (Object.hasOwn(value, "activeSidebarTab")) {
    const activeSidebarTab = enumValue(value.activeSidebarTab, ["review-map", "files", "findings"] as const);
    if (activeSidebarTab == null) return null;
    snapshot.activeSidebarTab = activeSidebarTab;
  }
  if (Object.hasOwn(value, "currentScope")) {
    const currentScope = decodeScope(value.currentScope);
    if (currentScope == null) return null;
    snapshot.currentScope = currentScope;
  }
  if (Object.hasOwn(value, "selectedCommitSha")) {
    const selectedCommitSha = nullableString(value.selectedCommitSha, MAX_ID_LENGTH);
    if (selectedCommitSha === INVALID || (selectedCommitSha != null && !context.commitShas.has(selectedCommitSha))) return null;
    snapshot.selectedCommitSha = selectedCommitSha;
  }
  if (Object.hasOwn(value, "activeInsight")) {
    const activeInsight = value.activeInsight;
    if (!isRecord(activeInsight) || !hasKeys(activeInsight, ["type", "id"])) return null;
    const type = enumValue(activeInsight.type, ["default", "chapter", "finding", "comment"] as const);
    const id = nullableString(activeInsight.id, MAX_ID_LENGTH);
    const commentIds = new Set(snapshot.comments?.map((comment) => comment.id) ?? []);
    if (type == null || id === INVALID) return null;
    if (type === "default" && id !== null) return null;
    if (type === "chapter" && (id == null || !context.chapterIds.has(id))) return null;
    if (type === "finding" && (id == null || !context.findingIds.has(id))) return null;
    if (type === "comment" && (id == null || !commentIds.has(id))) return null;
    snapshot.activeInsight = { type, id };
  }
  for (const key of ["hideUnchanged", "wrapLines", "sidebarCollapsed", "aiReviewCompleted"] as const) {
    if (Object.hasOwn(value, key)) {
      if (typeof value[key] !== "boolean") return null;
      snapshot[key] = value[key] as boolean;
    }
  }
  if (Object.hasOwn(value, "aiReviewStatus")) {
    const aiReviewStatus = enumValue(value.aiReviewStatus, ["idle", "running", "done", "failed"] as const);
    if (aiReviewStatus == null) return null;
    snapshot.aiReviewStatus = aiReviewStatus;
  }
  if (Object.hasOwn(value, "dismissedFindingLocationKeys")) {
    const keys = decodeStrings(value.dismissedFindingLocationKeys, true);
    if (keys == null) return null;
    snapshot.dismissedFindingLocationKeys = keys;
  }
  if (Object.hasOwn(value, "updatedAt")) {
    const updatedAt = stringValue(value.updatedAt, MAX_ID_LENGTH);
    if (updatedAt == null) return null;
    snapshot.updatedAt = updatedAt;
  }
  return snapshot;
}

export function decodeRendererReady(value: unknown): RendererReadyMessage | null {
  return isRecord(value) && hasKeys(value, ["type"]) && value.type === "renderer-ready" ? { type: "renderer-ready" } : null;
}

export function decodeReviewPublishGitHubReviewResultMessage(
  value: unknown,
  context: RendererProtocolContext,
): ReviewPublishGitHubReviewResultMessage | null {
  if (!isWithinMessageBudget(value) || !isRecord(value) || value.type !== "publish-github-review-result") return null;
  const requestId = idValue(value.requestId);
  if (requestId == null || typeof value.ok !== "boolean") return null;

  if (!value.ok) {
    if (!hasKeys(value, ["type", "requestId", "ok", "message"])) return null;
    const message = stringValue(value.message, MAX_TEXT_LENGTH, true);
    return message == null ? null : { type: "publish-github-review-result", requestId, ok: false, message };
  }

  if (!hasKeys(value, [
    "type", "requestId", "ok", "message", "publishedCommentIds", "publishedComments", "submittedAt", "warnings",
  ], ["reviewId", "reviewUrl"])) return null;
  const message = stringValue(value.message, MAX_TEXT_LENGTH, true);
  const publishedCommentIds = decodeIds(value.publishedCommentIds);
  const publishedComments = decodeComments(value.publishedComments, context);
  const submittedAt = stringValue(value.submittedAt, MAX_ID_LENGTH, true);
  const warnings = decodeStrings(value.warnings);
  const reviewId = Object.hasOwn(value, "reviewId") ? value.reviewId : undefined;
  const reviewUrl = Object.hasOwn(value, "reviewUrl") ? stringValue(value.reviewUrl, MAX_TEXT_LENGTH, true) : undefined;
  if (message == null
    || publishedCommentIds == null
    || publishedComments == null
    || submittedAt == null
    || warnings == null
    || reviewUrl === null
    || (reviewId !== undefined && (typeof reviewId !== "number" || !Number.isSafeInteger(reviewId) || reviewId <= 0))
    || publishedCommentIds.length !== publishedComments.length
    || publishedComments.some((comment, index) => comment.id !== publishedCommentIds[index]
      || comment.status !== "published"
      || comment.published !== true
      || stringValue(comment.publishedAt, MAX_ID_LENGTH, true) == null
      || (reviewId !== undefined && comment.githubReviewId !== reviewId)
      || (reviewUrl !== undefined && comment.githubReviewUrl !== reviewUrl))) return null;

  return {
    type: "publish-github-review-result",
    requestId,
    ok: true,
    message,
    publishedCommentIds,
    publishedComments,
    submittedAt,
    ...(typeof reviewId === "number" ? { reviewId } : {}),
    ...(reviewUrl === undefined ? {} : { reviewUrl }),
    warnings,
  };
}

export function decodeRendererMessage(value: unknown, context: RendererProtocolContext): DecodedRendererMessage | null {
  if (!isWithinMessageBudget(value)) return null;
  if (!isRecord(value) || !hasKeys(value, ["protocol", "sessionId", "capability", "message"])) return null;
  if (value.protocol !== 1 || value.sessionId !== context.sessionId || value.capability !== context.capability || !isRecord(value.message)) return null;
  const message = value.message;
  switch (message.type) {
    case "renderer-booted":
      return hasKeys(message, ["type"]) ? { type: "renderer-booted" } : null;
    case "cancel":
      return hasKeys(message, ["type"]) ? { type: "cancel" } : null;
    case "submit":
      return decodeSubmit(message, context);
    case "request-file": {
      if (!hasKeys(message, ["type", "requestId", "fileId", "scope"], ["commitSha"])) return null;
      const requestId = idValue(message.requestId);
      const fileId = fileIdValue(message.fileId, context);
      const scope = decodeScope(message.scope);
      const commitSha = Object.hasOwn(message, "commitSha") ? idValue(message.commitSha) : undefined;
      if (requestId == null || fileId == null || scope == null || commitSha === null || !hasKnownFileScope(context, fileId, scope, commitSha)) return null;
      return { type: "request-file", requestId, fileId, scope, commitSha };
    }
    case "run-ai-review": {
      if (!hasKeys(message, ["type", "requestId"])) return null;
      const requestId = idValue(message.requestId);
      return requestId == null ? null : { type: "run-ai-review", requestId };
    }
    case "refresh-github-context": {
      if (!hasKeys(message, ["type", "requestId"])) return null;
      const requestId = idValue(message.requestId);
      return requestId == null ? null : { type: "refresh-github-context", requestId };
    }
    case "open-external-url": {
      if (!hasKeys(message, ["type", "url"])) return null;
      const url = stringValue(message.url, 2_048, true);
      if (url == null) return null;
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" ? { type: "open-external-url", url: parsed.href } : null;
      } catch {
        return null;
      }
    }
    case "checkpoint-session": {
      if (!hasKeys(message, ["type", "snapshot"])) return null;
      const snapshot = decodeSnapshot(message.snapshot, context);
      return snapshot == null ? null : { type: "checkpoint-session", snapshot };
    }
    case "save-session": {
      if (!hasKeys(message, ["type", "snapshot"], ["requestId"])) return null;
      const requestId = Object.hasOwn(message, "requestId") ? idValue(message.requestId) : undefined;
      const snapshot = decodeSnapshot(message.snapshot, context);
      return snapshot == null || requestId === null ? null : { type: "save-session", requestId, snapshot };
    }
    case "publish-github-review": {
      if (!hasKeys(message, ["type", "requestId", "event", "body", "submit"])) return null;
      const requestId = idValue(message.requestId);
      const event = enumValue(message.event, ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const);
      const body = stringValue(message.body);
      const submit = decodeSubmit(message.submit, context);
      return requestId == null || event == null || body == null || submit == null ? null : { type: "publish-github-review", requestId, event, body, submit };
    }
    default:
      return null;
  }
}
