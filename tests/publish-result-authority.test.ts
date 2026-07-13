import assert from "node:assert/strict";
import test from "node:test";
import * as reviewIndex from "../src/index.js";
import * as rendererProtocol from "../src/renderer-protocol.js";
import { createGitHubPublishSessionController } from "../src/session-store.js";
import * as publishCommentState from "../web/publish-comment-state.js";
import type { RendererProtocolContext } from "../src/renderer-protocol.js";
import type { DiffReviewComment, GitHubReviewPublishIntent } from "../src/types.js";

const context: RendererProtocolContext = {
  sessionId: "session",
  capability: "capability",
  files: new Map([["file-1", { scopes: new Set(["git-diff"]), commitShas: new Set() }]]),
  commitShas: new Set(),
  findingIds: new Set(),
  chapterIds: new Set(),
};

function submittedComment(body: string): DiffReviewComment {
  return {
    id: "comment-1",
    fileId: "file-1",
    scope: "git-diff",
    side: "modified",
    startLine: 4,
    endLine: null,
    body,
  };
}

test("an A-ambiguous/B-retry success carries and applies authoritative A across host and renderer", async () => {
  const buildResult = (reviewIndex as Record<string, unknown>).buildGitHubPublishSuccessResult;
  const decodeResult = (rendererProtocol as Record<string, unknown>).decodeReviewPublishGitHubReviewResultMessage;
  const applyAuthoritative = (publishCommentState as Record<string, unknown>).applyAuthoritativePublishedCommentState;
  assert.equal(typeof buildResult, "function");
  assert.equal(typeof decodeResult, "function");
  assert.equal(typeof applyAuthoritative, "function");
  if (typeof buildResult !== "function" || typeof decodeResult !== "function" || typeof applyAuthoritative !== "function") return;

  const originalA = submittedComment("Body A that the ambiguous request may have published.");
  const currentRetryB = submittedComment("Body B edited before retrying.");
  const ambiguousIntent: GitHubReviewPublishIntent = {
    version: 1,
    status: "ambiguous",
    correlationId: "review-intent-authority-1234",
    source: {
      sourceKey: "github:owner/repo:pull/7",
      owner: "owner",
      repo: "repo",
      pullNumber: 7,
      reviewedBaseSha: "reviewed-base-sha",
      reviewedHeadSha: "reviewed-head-sha",
    },
    representedCommentIds: [originalA.id],
    submittedComments: [originalA],
    createdAt: "2026-07-10T09:00:00Z",
    updatedAt: "2026-07-10T09:30:00Z",
  };
  let currentSnapshot = { comments: [currentRetryB] };
  let recordState = { revision: 3, recordHash: "a".repeat(64) };
  const controller = createGitHubPublishSessionController({
    source: ambiguousIntent.source,
    initialIntent: ambiguousIntent,
    getSnapshot: () => currentSnapshot,
    getRecordState: () => recordState,
    persistSnapshot: async (snapshot) => {
      currentSnapshot = { comments: snapshot.comments ?? [] };
      recordState = { revision: recordState.revision + 1, recordHash: "b".repeat(64) };
      return true;
    },
    now: () => "2026-07-10T09:30:00Z",
  });
  await controller.reconcileOutstanding(async () => ({
      reviewId: 4321,
      reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-4321",
      submittedAt: "2026-07-10T09:29:00Z",
      warnings: [],
  }));
  const hostResult = (buildResult as (options: Record<string, unknown>) => unknown)({
    requestId: "retry-b",
    message: "Reconciled the previously ambiguous GitHub review.",
    confirmedIntent: controller.intent,
  });
  const decoded = (decodeResult as (value: unknown, context: RendererProtocolContext) => any)(hostResult, context);
  assert.ok(decoded);
  assert.deepEqual(decoded.publishedCommentIds, ["comment-1"]);
  assert.equal(decoded.publishedComments[0].body, originalA.body);
  assert.equal(decoded.publishedComments[0].status, "published");
  assert.equal(decoded.publishedComments[0].githubReviewId, 4321);

  const rendered = (applyAuthoritative as (
    comments: DiffReviewComment[],
    publishedComments: DiffReviewComment[],
  ) => DiffReviewComment[])([
    currentRetryB,
    { ...submittedComment("Unrelated draft."), id: "unrelated" },
  ], decoded.publishedComments);
  assert.equal(rendered[0]?.body, originalA.body);
  assert.equal(rendered[0]?.status, "published");
  assert.equal(rendered.some((comment) => comment.body === currentRetryB.body), false);
  assert.equal(rendered[1]?.id, "unrelated");
});

test("strict success decoding rejects missing, staged, or ID-mismatched authoritative comments", () => {
  const decodeResult = (rendererProtocol as Record<string, unknown>).decodeReviewPublishGitHubReviewResultMessage;
  assert.equal(typeof decodeResult, "function");
  if (typeof decodeResult !== "function") return;
  const decode = decodeResult as (value: unknown, context: RendererProtocolContext) => unknown;
  const published = {
    ...submittedComment("Authoritative."),
    status: "published",
    published: true,
    publishedAt: "2026-07-10T09:29:00Z",
  };
  const base = {
    type: "publish-github-review-result",
    requestId: "request",
    ok: true,
    message: "Submitted.",
    publishedCommentIds: ["comment-1"],
    publishedComments: [published],
    submittedAt: "2026-07-10T09:29:00Z",
    warnings: [],
  };

  assert.ok(decode(base, context));
  assert.equal(decode({ ...base, publishedComments: undefined }, context), null);
  assert.equal(decode({ ...base, publishedComments: [{ ...published, status: "staged", published: false }] }, context), null);
  assert.equal(decode({ ...base, publishedCommentIds: ["different"] }, context), null);
});
