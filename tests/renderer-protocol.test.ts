import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRendererMessage,
  decodeRendererReady,
  type RendererProtocolContext,
} from "../src/renderer-protocol.js";

const context: RendererProtocolContext = {
  sessionId: "session-1",
  capability: "capability-1",
  files: new Map([
    ["diff", { scopes: new Set(["git-diff", "last-commit", "all-files"]), commitShas: new Set() }],
    ["commit", { scopes: new Set(["commit"]), commitShas: new Set(["abc123"]) }],
  ]),
  commitShas: new Set(["abc123"]),
  findingIds: new Set(["finding-1"]),
  chapterIds: new Set(["chapter-1"]),
};

function frame(message: Record<string, unknown>): Record<string, unknown> {
  return frameFor(context, message);
}

function frameFor(protocolContext: RendererProtocolContext, message: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: 1,
    sessionId: protocolContext.sessionId,
    capability: protocolContext.capability,
    message,
  };
}

function comment(id: string, body = "Please add coverage."): Record<string, unknown> {
  return {
    id,
    fileId: "diff",
    scope: "git-diff",
    side: "modified",
    startLine: 2,
    endLine: null,
    body,
  };
}

function submit(): Record<string, unknown> {
  return {
    type: "submit",
    overallComment: "Summary",
    comments: [comment("comment-1")],
    acceptedFindings: [{ findingId: "finding-1", body: "Accepted." }],
    findingStatuses: [{ findingId: "finding-1", status: "accepted-comment" }],
    approvalPacket: {
      summary: "Reviewed",
      reviewedChapters: ["chapter-1"],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "One note.",
    },
  };
}

test("renderer-ready is the sole accepted pre-capability message", () => {
  assert.deepEqual(decodeRendererReady({ type: "renderer-ready" }), { type: "renderer-ready" });
  for (const value of [null, "renderer-ready", [], { type: "renderer-ready", extra: true }, { type: "submit" }]) {
    assert.equal(decodeRendererReady(value), null);
  }
});

test("decodes each authenticated renderer command", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["booted", { type: "renderer-booted" }, "renderer-booted"],
    ["cancel", { type: "cancel" }, "cancel"],
    ["request", { type: "request-file", requestId: "request-1", fileId: "diff", scope: "git-diff" }, "request-file"],
    ["commit request", { type: "request-file", requestId: "request-1", fileId: "commit", scope: "commit", commitSha: "abc123" }, "request-file"],
    ["AI", { type: "run-ai-review", requestId: "ai-1" }, "run-ai-review"],
    ["GitHub context", { type: "refresh-github-context", requestId: "context-1" }, "refresh-github-context"],
    ["external URL", { type: "open-external-url", url: "https://github.com/headout/magellan/pull/646" }, "open-external-url"],
    ["checkpoint", { type: "checkpoint-session", snapshot: { activeFileId: "diff", comments: [] } }, "checkpoint-session"],
    ["save", { type: "save-session", requestId: "save-1", snapshot: { activeFileId: "diff", currentScope: "git-diff", selectedCommitSha: null, comments: [] } }, "save-session"],
    ["submit", submit(), "submit"],
    ["publish", { type: "publish-github-review", requestId: "publish-1", event: "REQUEST_CHANGES", body: "Please revise.", submit: submit() }, "publish-github-review"],
  ];

  for (const [name, message, type] of cases) {
    const decoded = decodeRendererMessage(frame(message), context);
    assert.ok(decoded, name);
    assert.equal(decoded.type, type, name);
  }
});

test("rejects non-objects, bad envelope fields, stale sessions, and unknown messages", () => {
  const cases: unknown[] = [
    null,
    "message",
    [],
    { protocol: 1, sessionId: context.sessionId, capability: context.capability },
    { ...frame({ type: "cancel" }), protocol: 2 },
    { ...frame({ type: "cancel" }), sessionId: "stale" },
    { ...frame({ type: "cancel" }), capability: "stale" },
    { ...frame({ type: "cancel" }), extra: true },
    frame({ type: "unknown" }),
    frame({ type: "cancel", extra: true }),
  ];
  for (const value of cases) assert.equal(decodeRendererMessage(value, context), null);
});

test("rejects unauthorized request-file combinations", () => {
  const cases: Record<string, unknown>[] = [
    { type: "request-file", requestId: "r", fileId: "missing", scope: "git-diff" },
    { type: "request-file", requestId: "r", fileId: "diff", scope: "commit", commitSha: "abc123" },
    { type: "request-file", requestId: "r", fileId: "commit", scope: "commit", commitSha: "unknown" },
    { type: "request-file", requestId: "r", fileId: "commit", scope: "commit" },
    { type: "request-file", requestId: "r", fileId: "diff", scope: "git-diff", commitSha: "abc123" },
  ];
  for (const message of cases) assert.equal(decodeRendererMessage(frame(message), context), null);
});

test("accepts host-authorized file ids longer than generic protocol ids", () => {
  const longFileId = `${"nested/".repeat(60)}file.py::working::${"nested/".repeat(60)}file.py`;
  assert.equal(longFileId.length > 256, true);
  const longPathContext: RendererProtocolContext = {
    ...context,
    files: new Map([
      [longFileId, { scopes: new Set(["git-diff"]), commitShas: new Set() }],
    ]),
  };

  const request = decodeRendererMessage(frameFor(longPathContext, {
    type: "request-file",
    requestId: "request-1",
    fileId: longFileId,
    scope: "git-diff",
  }), longPathContext);
  assert.equal(request?.type, "request-file");

  const save = decodeRendererMessage(frameFor(longPathContext, {
    type: "save-session",
    snapshot: {
      activeFileId: longFileId,
      comments: [{
        ...comment("long-path-comment"),
        fileId: longFileId,
      }],
    },
  }), longPathContext);
  assert.equal(save?.type, "save-session");

  const unknownLongFileId = `${longFileId}-unknown`;
  assert.equal(decodeRendererMessage(frameFor(longPathContext, {
    type: "request-file",
    requestId: "request-2",
    fileId: unknownLongFileId,
    scope: "git-diff",
  }), longPathContext), null);
});

test("rejects malformed nested submit and snapshot data without coercion", () => {
  const malformedComment = submit();
  (malformedComment.comments as Record<string, unknown>[])[0] = { ...((malformedComment.comments as Record<string, unknown>[])[0]), fileId: "missing" };
  const malformedApproval = submit();
  (malformedApproval.approvalPacket as Record<string, unknown>).suggestedVerdict = "ship-it";
  const malformedSnapshot = {
    type: "save-session",
    snapshot: {
      currentScope: "commit",
      selectedCommitSha: "unknown",
      comments: [{ id: "comment", fileId: "diff", scope: "git-diff", side: "file", startLine: 1, endLine: null, body: "bad line" }],
    },
  };
  const overlong = { type: "run-ai-review", requestId: "x".repeat(257) };

  for (const message of [malformedComment, malformedApproval, malformedSnapshot, overlong]) {
    assert.equal(decodeRendererMessage(frame(message), context), null);
  }
});

test("rejects unknown fields and invalid enum values in privileged commands", () => {
  const invalidPublish = {
    type: "publish-github-review",
    requestId: "publish-1",
    event: "MERGE",
    body: "body",
    submit: submit(),
  };
  const invalidStatus = submit();
  (invalidStatus.findingStatuses as Record<string, unknown>[])[0].status = "ignored";
  const invalidSide = submit();
  (invalidSide.comments as Record<string, unknown>[])[0].side = "left";
  const unknownSnapshotField = {
    type: "save-session",
    snapshot: { activeFileId: "diff", currentScope: "git-diff", surprise: true },
  };

  const unsafeUrl = { type: "open-external-url", url: "javascript:alert(1)" };
  const insecureUrl = { type: "open-external-url", url: "http://github.com/headout/magellan/pull/646" };
  const forgedContext = { type: "github-context-result", requestId: "context-1", ok: true, context: {} };

  for (const message of [invalidPublish, invalidStatus, invalidSide, unknownSnapshotField, unsafeUrl, insecureUrl, forgedContext]) {
    assert.equal(decodeRendererMessage(frame(message), context), null);
  }
});

test("renderer checkpoints cannot overwrite host-owned map, analysis, or publish state", () => {
  for (const snapshot of [
    { map: { version: 2, status: "semantic" } },
    { analysis: { status: "ready" } },
    { githubPublishIntent: { status: "confirmed" } },
    { githubContext: { owner: "attacker" } },
  ]) {
    assert.equal(decodeRendererMessage(frame({ type: "checkpoint-session", snapshot }), context), null);
  }
});

test("rejects aggregate-oversized submit and save messages while accepting a realistic large review", () => {
  const realistic = submit();
  realistic.comments = Array.from({ length: 50 }, (_, index) => comment(`comment-${index}`, "r".repeat(20_000)));
  assert.equal(decodeRendererMessage(frame(realistic), context)?.type, "submit");

  const oversizedSubmit = submit();
  oversizedSubmit.comments = Array.from({ length: 90 }, (_, index) => comment(`oversized-${index}`, "x".repeat(100_000)));
  assert.equal(decodeRendererMessage(frame(oversizedSubmit), context), null);

  const findingIds = Array.from({ length: 90 }, (_, index) => `finding-${index}`);
  const largeContext: RendererProtocolContext = {
    ...context,
    findingIds: new Set(findingIds),
  };
  const oversizedSave = {
    type: "save-session",
    snapshot: {
      acceptedFindingComments: Object.fromEntries(findingIds.map((findingId) => [findingId, "x".repeat(100_000)])),
    },
  };
  assert.equal(decodeRendererMessage(frameFor(largeContext, oversizedSave), largeContext), null);
});

test("rejects duplicate identifiers throughout submit, publish, approval, and snapshot collections", () => {
  const duplicateComments = submit();
  duplicateComments.comments = [comment("duplicate"), comment("duplicate", "A second body")];

  const duplicateAccepted = submit();
  duplicateAccepted.acceptedFindings = [
    { findingId: "finding-1", body: "First" },
    { findingId: "finding-1", body: "Second" },
  ];

  const duplicateStatuses = submit();
  duplicateStatuses.findingStatuses = [
    { findingId: "finding-1", status: "new" },
    { findingId: "finding-1", status: "dismissed" },
  ];

  const duplicateReviewedChapters = submit();
  (duplicateReviewedChapters.approvalPacket as Record<string, unknown>).reviewedChapters = ["chapter-1", "chapter-1"];

  const duplicateUnresolvedFindings = submit();
  (duplicateUnresolvedFindings.approvalPacket as Record<string, unknown>).unresolvedFindings = ["finding-1", "finding-1"];

  const duplicateSnapshotComments = {
    type: "save-session",
    snapshot: { comments: [comment("duplicate"), comment("duplicate", "Second")] },
  };
  const duplicateDismissedLocations = {
    type: "save-session",
    snapshot: { dismissedFindingLocationKeys: ["finding-1:diff:2", "finding-1:diff:2"] },
  };
  const duplicatePublish = {
    type: "publish-github-review",
    requestId: "publish-1",
    event: "COMMENT",
    body: "Review",
    submit: duplicateComments,
  };

  for (const message of [
    duplicateComments,
    duplicateAccepted,
    duplicateStatuses,
    duplicateReviewedChapters,
    duplicateUnresolvedFindings,
    duplicateSnapshotComments,
    duplicateDismissedLocations,
    duplicatePublish,
  ]) {
    assert.equal(decodeRendererMessage(frame(message), context), null);
  }
});

test("does not coerce invalid nullable comment lines or snapshot identifiers to null", () => {
  const invalidFileStart = submit();
  invalidFileStart.comments = [{ ...comment("file-start"), side: "file", startLine: "invalid", endLine: null }];
  const invalidFileEnd = submit();
  invalidFileEnd.comments = [{ ...comment("file-end"), side: "file", startLine: null, endLine: 0 }];
  const invalidLineEnd = submit();
  invalidLineEnd.comments = [{ ...comment("line-end"), endLine: "invalid" }];
  const invalidActiveFile = { type: "save-session", snapshot: { activeFileId: 42 } };
  const invalidCommit = { type: "save-session", snapshot: { selectedCommitSha: 42 } };
  const invalidDefaultInsight = { type: "save-session", snapshot: { activeInsight: { type: "default", id: "not-null" } } };
  const invalidCommentInsight = {
    type: "save-session",
    snapshot: { comments: [comment("known-comment")], activeInsight: { type: "comment", id: "unknown-comment" } },
  };
  const malformedCommentInsight = { type: "save-session", snapshot: { comments: [], activeInsight: { type: "comment", id: 42 } } };

  for (const message of [
    invalidFileStart,
    invalidFileEnd,
    invalidLineEnd,
    invalidActiveFile,
    invalidCommit,
    invalidDefaultInsight,
    invalidCommentInsight,
    malformedCommentInsight,
  ]) {
    assert.equal(decodeRendererMessage(frame(message), context), null);
  }

  const validCommentInsight = {
    type: "save-session",
    snapshot: { comments: [comment("known-comment")], activeInsight: { type: "comment", id: "known-comment" } },
  };
  assert.equal(decodeRendererMessage(frame(validCommentInsight), context)?.type, "save-session");
});

test("preserves published receipt metadata in authenticated session saves", () => {
  const decoded = decodeRendererMessage(frame({
    type: "save-session",
    snapshot: {
      comments: [{
        ...comment("published-comment"),
        status: "published",
        published: true,
        publishedAt: "2026-07-10T09:00:00Z",
        githubReviewId: 1234,
        githubReviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-1234",
      }],
    },
  }), context);

  assert.equal(decoded?.type, "save-session");
  if (decoded?.type !== "save-session") return;
  assert.deepEqual(decoded.snapshot.comments?.[0], {
    ...comment("published-comment"),
    commitSha: undefined,
    status: "published",
    published: true,
    publishedAt: "2026-07-10T09:00:00Z",
    githubReviewId: 1234,
    githubReviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-1234",
  });
});

test("creates decoded snapshot maps without object prototypes", () => {
  const decoded = decodeRendererMessage(frame({
    type: "save-session",
    snapshot: {
      acceptedFindingComments: { "finding-1": "Accepted" },
      findingStatuses: { "finding-1": "accepted-comment" },
      reviewedFiles: { diff: true },
      reviewedChapters: { "chapter-1": true },
    },
  }), context);

  assert.equal(decoded?.type, "save-session");
  if (decoded?.type !== "save-session") return;
  for (const value of [
    decoded.snapshot.acceptedFindingComments,
    decoded.snapshot.findingStatuses,
    decoded.snapshot.reviewedFiles,
    decoded.snapshot.reviewedChapters,
  ]) {
    assert.equal(Object.getPrototypeOf(value), null);
  }
});
