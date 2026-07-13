import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGitHubReviewPublishPlan, publishGitHubReview } from "../src/github-publish.js";
import * as githubPublish from "../src/github-publish.js";
import {
  markGitHubReviewCommentsPublished,
  mergeAuthoritativePublishedComments,
} from "../src/session-store.js";
import * as sessionStore from "../src/session-store.js";
import type { DiffReviewComment, ReviewSessionSnapshot, ReviewSubmitPayload } from "../src/types.js";

const filePathById = new Map([["file-1", "src/app/api/qa_api.py"]]);
const commentableLinesByFileId = new Map([[
  "file-1",
  {
    original: [{ start: 10, end: 12 }],
    modified: [{ start: 40, end: 45 }],
  },
]]);
const correlationId = "review-intent-1234567890";
const correlationMarker = `<!-- pi-diff-review-cockpit:review-intent:${correlationId} -->`;
const publishDependencies = { reviewedBaseSha: "base-immutable-sha" };

test("the correlation marker and persisted validator share the exact URL-safe length contract", () => {
  const validate = (githubPublish as Record<string, unknown>).isGitHubReviewCorrelationId;
  assert.equal(typeof validate, "function");
  if (typeof validate !== "function") return;
  const isValid = validate as (value: unknown) => boolean;

  assert.equal(isValid("a".repeat(16)), true);
  assert.equal(isValid(`a${"_".repeat(127)}`), true);
  for (const invalid of ["x", "a".repeat(129), "_123456789012345", "a12345678901234!"]) {
    assert.equal(isValid(invalid), false, invalid);
    assert.throws(() => githubPublish.githubReviewCorrelationMarker(invalid), /16-128 URL-safe/);
  }
});

function payload(): ReviewSubmitPayload {
  return {
    type: "submit",
    overallComment: "Looks good with one note.",
    comments: [{
      id: "c1",
      fileId: "file-1",
      scope: "git-diff",
      side: "modified",
      startLine: 42,
      endLine: null,
      body: "Please add a regression test here.",
    }],
    acceptedFindings: [{ findingId: "f1", body: "This migration needs a rollback note." }],
    findingStatuses: [{ findingId: "f1", status: "accepted-comment" }],
    approvalPacket: {
      summary: "Summary",
      reviewedChapters: [],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "Approval packet body",
    },
  };
}

function buildOptions(submit: ReviewSubmitPayload, event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE" = "COMMENT") {
  return {
    event,
    body: "Review body",
    submit,
    filePathById,
    commentableLinesByFileId,
    correlationId,
  };
}

const metadata = {
  owner: "headout",
  repo: "magellan",
  number: 646,
  url: "https://github.com/headout/magellan/pull/646",
  title: "QA dataset labeler",
  body: "Adds QA dataset labeler.",
  author: "dev",
  baseRefName: "main",
  headRefName: "feat/qa",
  headRepositoryOwner: "fork-owner",
  isDraft: false,
  state: "OPEN",
};
type PullMetadata = typeof metadata;

function publishPayload() {
  return {
    event: "COMMENT" as const,
    commit_id: "head-immutable-sha",
    body: `Review body\n\n${correlationMarker}`,
    comments: [],
  };
}

function livePull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 987654,
    number: 646,
    state: "open",
    locked: false,
    merged: false,
    merged_at: null,
    html_url: metadata.url,
    head: {
      label: "fork-owner:feat/qa",
      ref: "feat/qa",
      sha: "head-immutable-sha",
      repo: { full_name: "fork-owner/magellan" },
    },
    base: {
      label: "headout:main",
      ref: "main",
      sha: "base-immutable-sha",
      repo: { full_name: "headout/magellan" },
    },
    ...overrides,
  };
}

function fakePublishPi(options: {
  preflight: unknown;
  post?: { code?: number; stdout?: string; stderr?: string };
  postError?: Error;
  reviews?: unknown;
  calls: string[];
}): ExtensionAPI {
  return {
    exec: async (command: string, args: string[]) => {
      const methodIndex = args.indexOf("--method");
      const method = methodIndex >= 0 ? args[methodIndex + 1] : undefined;
      options.calls.push(`${command} ${method ?? ""} ${args[1] ?? ""}`.trim());
      if (method === "GET") {
        if (args[1]?.endsWith("/reviews")) {
          return { code: 0, stdout: JSON.stringify(options.reviews ?? []), stderr: "" };
        }
        return { code: 0, stdout: JSON.stringify(options.preflight), stderr: "" };
      }
      if (method === "POST") {
        if (options.postError != null) throw options.postError;
        return { code: options.post?.code ?? 0, stdout: options.post?.stdout ?? "", stderr: options.post?.stderr ?? "" };
      }
      assert.fail(`unexpected gh API command: ${command} ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;
}

test("builds one SHA-pinned publish plan that represents inline and file comments exactly once", () => {
  const submit = payload();
  submit.comments.push({
    id: "file-comment",
    fileId: "file-1",
    scope: "all-files",
    side: "file",
    startLine: null,
    endLine: null,
    body: "Whole-file note.",
  });

  const result = buildGitHubReviewPublishPlan({
    ...buildOptions(submit),
    reviewedHeadSha: "head-immutable-sha",
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.representedCommentIds, ["c1", "file-comment"]);
  assert.deepEqual(result.payload, {
    event: "COMMENT",
    commit_id: "head-immutable-sha",
    body: [
      "Review body",
      "## Accepted AI findings",
      "1. This migration needs a rollback note.",
      "## File comments",
      "### <code>src/app/api/qa_api.py</code>",
      "1. Whole-file note.",
      correlationMarker,
    ].join("\n\n"),
    comments: [{
      path: "src/app/api/qa_api.py",
      body: "Please add a regression test here.",
      side: "RIGHT",
      line: 42,
    }],
  });
});

test("indents and trims multiline accepted findings and file comments as Markdown list items", () => {
  const submit = payload();
  submit.acceptedFindings = [{
    findingId: "f1",
    body: "  First finding line.\nContinuation line.\n\nFinal paragraph.  ",
  }];
  submit.comments = [{
    id: "file-comment",
    fileId: "file-1",
    scope: "all-files",
    side: "file",
    startLine: null,
    endLine: null,
    body: "  First file line.\nContinuation line.  ",
  }];

  const result = buildGitHubReviewPublishPlan({
    ...buildOptions(submit),
    reviewedHeadSha: "head-immutable-sha",
  });

  assert.equal(result.payload?.body, [
    "Review body",
    "## Accepted AI findings",
    "1. First finding line.\n   Continuation line.\n\n   Final paragraph.",
    "## File comments",
    "### <code>src/app/api/qa_api.py</code>",
    "1. First file line.\n   Continuation line.",
    correlationMarker,
  ].join("\n\n"));
});

test("renders file-comment paths as inert Markdown data", () => {
  const submit = payload();
  submit.acceptedFindings = [];
  submit.comments = [{
    id: "unsafe-path",
    fileId: "file-1",
    scope: "all-files",
    side: "file",
    startLine: null,
    endLine: null,
    body: "Review this unusual file name.",
  }];
  const unsafePath = "src/`name\n## injected <tag>.py";
  const result = buildGitHubReviewPublishPlan({
    ...buildOptions(submit),
    reviewedHeadSha: "head-immutable-sha",
    filePathById: new Map([["file-1", unsafePath]]),
  });

  assert.ok(result.payload);
  assert.doesNotMatch(result.payload.body, /\n## injected/);
  assert.match(result.payload.body, /### <code>src\/`name\\n## injected &lt;tag&gt;\.py<\/code>/);
});

test("rejects an entire plan when any submitted comment is malformed, published, or spans hunks", () => {
  const submit = payload();
  submit.comments = [
    {
      id: "crosses-hunks",
      fileId: "file-1",
      scope: "git-diff",
      side: "modified",
      startLine: 41,
      endLine: 44,
      body: "This crosses two hunks.",
    },
    {
      id: "published",
      fileId: "file-1",
      scope: "git-diff",
      side: "modified",
      startLine: 42,
      endLine: null,
      body: "Already published.",
      status: "published",
      published: true,
    },
    {
      id: "unsupported-scope",
      fileId: "file-1",
      scope: "last-commit",
      side: "modified",
      startLine: 42,
      endLine: null,
      body: "Wrong scope.",
    },
    {
      id: "malformed-file-comment",
      fileId: "file-1",
      scope: "git-diff",
      side: "file",
      startLine: 42,
      endLine: null,
      body: "A whole-file comment cannot carry a line.",
    },
  ];

  const result = buildGitHubReviewPublishPlan({
    ...buildOptions(submit),
    reviewedHeadSha: "head-immutable-sha",
    commentableLinesByFileId: new Map([[
      "file-1",
      { original: [{ start: 10, end: 12 }], modified: [{ start: 40, end: 42 }, { start: 43, end: 45 }] },
    ]]),
  });

  assert.equal(result.payload, null);
  assert.deepEqual(result.representedCommentIds, []);
  assert.deepEqual(result.errors.map(({ code, commentId }) => ({ code, commentId })), [
    { code: "range-crosses-hunks", commentId: "crosses-hunks" },
    { code: "already-published", commentId: "published" },
    { code: "unsupported-scope", commentId: "unsupported-scope" },
    { code: "invalid-file-comment", commentId: "malformed-file-comment" },
  ]);
});

test("revalidates the exact publish plan against the persisted snapshot immediately before POST", () => {
  const revalidate = (githubPublish as Record<string, unknown>).revalidateGitHubReviewPublishPlan;
  assert.equal(typeof revalidate, "function");
  if (typeof revalidate !== "function") return;

  const submit = payload();
  const options = {
    ...buildOptions(submit),
    reviewedHeadSha: "head-immutable-sha",
  };
  const expectedPlan = buildGitHubReviewPublishPlan(options);
  const persistedBase: ReviewSessionSnapshot = {
    overallComment: submit.overallComment,
    comments: structuredClone(submit.comments),
    acceptedFindingComments: { f1: submit.acceptedFindings[0]!.body },
    findingStatuses: { f1: "accepted-comment" },
  };
  const invoke = revalidate as (options: Record<string, unknown>) => ReturnType<typeof buildGitHubReviewPublishPlan>;

  const changed = invoke({
    expectedPlan,
    originalOptions: options,
    persistedSnapshot: {
      ...persistedBase,
      comments: [{ ...submit.comments[0]!, body: "Edited after the pending intent was saved." }],
    },
  });
  assert.equal(changed.payload, null);
  assert.deepEqual(changed.errors.map(({ code, commentId }) => ({ code, commentId })), [
    { code: "stale-publish-plan", commentId: "c1" },
  ]);

  const unrelated = invoke({
    expectedPlan,
    originalOptions: options,
    persistedSnapshot: {
      ...persistedBase,
      comments: [...submit.comments, {
        ...submit.comments[0]!,
        id: "new-unrelated-draft",
        body: "This draft is not part of the pending publish intent.",
      }],
    },
  });
  assert.deepEqual(unrelated, expectedPlan);
});

test("preflight rejects changed, closed, merged, and locked pull requests without POSTing", async () => {
  for (const [name, preflight] of [
    ["changed head", livePull({ head: { sha: "new-head" } })],
    ["changed base", livePull({ base: { sha: "new-base" } })],
    ["closed pull request", livePull({ state: "closed" })],
    ["merged pull request", livePull({ state: "closed", merged: true, merged_at: "2026-07-10T08:00:00Z" })],
    ["locked pull request", livePull({ locked: true })],
  ] as const) {
    const calls: string[] = [];
    await assert.rejects(
      publishGitHubReview(
        fakePublishPi({ preflight, calls }),
        "/repo",
        metadata,
        publishPayload(),
        { reviewedBaseSha: "base-immutable-sha" },
      ),
      /Refresh the review before publishing/,
      name,
    );
    assert.deepEqual(calls, ["gh GET repos/headout/magellan/pulls/646"], name);
  }
});

test("preflight GETs the current pull request before POSTing the commit-pinned review and returns its receipt", async () => {
  const calls: string[] = [];
  const receipt = await publishGitHubReview(
    fakePublishPi({
      preflight: livePull(),
      post: { stdout: JSON.stringify({ id: 1234, html_url: "https://github.com/headout/magellan/pull/646#pullrequestreview-1234", submitted_at: "2026-07-10T09:00:00Z" }) },
      calls,
    }),
    "/repo",
    metadata,
    publishPayload(),
    publishDependencies,
  );

  assert.deepEqual(calls, [
    "gh GET repos/headout/magellan/pulls/646",
    "gh POST repos/headout/magellan/pulls/646/reviews",
  ]);
  assert.deepEqual(receipt, {
    reviewId: 1234,
    reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-1234",
    submittedAt: "2026-07-10T09:00:00Z",
    warnings: [],
  });
});

test("returns a successful receipt with a warning when temporary cleanup fails after POST", async () => {
  const calls: string[] = [];
  const receipt = await publishGitHubReview(
    fakePublishPi({
      preflight: livePull(),
      post: { stdout: "not-json" },
      calls,
    }),
    "/repo",
    metadata,
    publishPayload(),
    {
      ...publishDependencies,
      cleanupTempDir: async () => {
        throw new Error("cleanup unavailable");
      },
    },
  );

  assert.deepEqual(calls, [
    "gh GET repos/headout/magellan/pulls/646",
    "gh POST repos/headout/magellan/pulls/646/reviews",
  ]);
  assert.equal(receipt.reviewId, undefined);
  assert.equal(receipt.warnings.length, 2);
  assert.match(receipt.warnings[0] ?? "", /parse/i);
  assert.match(receipt.warnings[1] ?? "", /cleanup unavailable/);
});

test("reconciles an ambiguous POST failure by its hidden correlation marker", async () => {
  const calls: string[] = [];
  const receipt = await (publishGitHubReview as unknown as (
    pi: ExtensionAPI,
    cwd: string,
    metadata: PullMetadata,
    payload: ReturnType<typeof publishPayload>,
    dependencies: Record<string, unknown>,
  ) => Promise<unknown>)(
    fakePublishPi({
      preflight: livePull(),
      post: { code: 1, stderr: "request timed out" },
      reviews: [[{
        id: 4321,
        body: `Review body\n\n${correlationMarker}`,
        commit_id: "head-immutable-sha",
        html_url: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
        submitted_at: "2026-07-10T09:30:00Z",
      }]],
      calls,
    }),
    "/repo",
    metadata,
    publishPayload(),
    { ...publishDependencies, correlationId },
  );

  assert.deepEqual(calls, [
    "gh GET repos/headout/magellan/pulls/646",
    "gh POST repos/headout/magellan/pulls/646/reviews",
    "gh GET repos/headout/magellan/pulls/646/reviews",
  ]);
  assert.deepEqual(receipt, {
    reviewId: 4321,
    reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
    submittedAt: "2026-07-10T09:30:00Z",
    warnings: ["GitHub accepted the review despite an ambiguous command result; the submission was reconciled by its correlation marker."],
  });
});

test("keeps an unmatched POST failure ambiguous instead of inviting a retry", async () => {
  const calls: string[] = [];
  const ambiguousError = (githubPublish as Record<string, unknown>).GitHubReviewPublishAmbiguousError;
  assert.equal(typeof ambiguousError, "function");

  await assert.rejects(
    (publishGitHubReview as unknown as (
      pi: ExtensionAPI,
      cwd: string,
      metadata: PullMetadata,
      payload: ReturnType<typeof publishPayload>,
      dependencies: Record<string, unknown>,
    ) => Promise<unknown>)(
      fakePublishPi({
        preflight: livePull(),
        postError: new Error("gh timed out after sending the request"),
        reviews: [[]],
        calls,
      }),
      "/repo",
      metadata,
      publishPayload(),
      { ...publishDependencies, correlationId },
    ),
    (error: unknown) => typeof ambiguousError === "function"
      && error instanceof (ambiguousError as new (...args: any[]) => Error)
      && /could not be confirmed/i.test(error.message),
  );
  assert.deepEqual(calls, [
    "gh GET repos/headout/magellan/pulls/646",
    "gh POST repos/headout/magellan/pulls/646/reviews",
    "gh GET repos/headout/magellan/pulls/646/reviews",
  ]);
});

test("preserves both the primary publish failure and cleanup failure", async () => {
  const calls: string[] = [];
  let thrown: unknown;
  try {
    await (publishGitHubReview as unknown as (
      pi: ExtensionAPI,
      cwd: string,
      metadata: PullMetadata,
      payload: ReturnType<typeof publishPayload>,
      dependencies: Record<string, unknown>,
    ) => Promise<unknown>)(
      fakePublishPi({
        preflight: livePull(),
        post: { code: 1, stderr: "POST failed" },
        reviews: [[]],
        calls,
      }),
      "/repo",
      metadata,
      publishPayload(),
      {
        ...publishDependencies,
        correlationId,
        cleanupTempDir: async () => { throw new Error("cleanup failed"); },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof AggregateError);
  assert.equal(thrown.errors.length, 2);
  assert.match(String(thrown.errors[0]), /could not be confirmed|POST failed/i);
  assert.match(String(thrown.errors[1]), /cleanup failed/i);
  assert.equal(thrown.cause, thrown.errors[0]);
});

test("prior published comments stay saved while a new staged comment alone is planned and published", async () => {
  const resolveSubmitted = (sessionStore as Record<string, unknown>).resolveSubmittedCommentsFromSnapshot;
  assert.equal(typeof resolveSubmitted, "function");
  if (typeof resolveSubmitted !== "function") return;

  const priorPublished: DiffReviewComment = {
    id: "published-prior",
    fileId: "file-1",
    scope: "git-diff",
    side: "modified",
    startLine: 41,
    endLine: null,
    body: "Already published note.",
    status: "published",
    published: true,
    publishedAt: "2026-07-09T09:00:00Z",
    githubReviewId: 1000,
  };
  const newStaged: DiffReviewComment = {
    id: "new-staged",
    fileId: "file-1",
    scope: "git-diff",
    side: "modified",
    startLine: 42,
    endLine: null,
    body: "New review note.",
  };
  const mergedSnapshot = mergeAuthoritativePublishedComments({ comments: [newStaged] }, [priorPublished]);
  const submit = payload();
  submit.comments = (resolveSubmitted as (
    comments: readonly DiffReviewComment[],
    snapshot: ReviewSessionSnapshot,
  ) => DiffReviewComment[])([newStaged], mergedSnapshot);
  const plan = buildGitHubReviewPublishPlan({
    ...buildOptions(submit),
    reviewedHeadSha: "head-immutable-sha",
  });

  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.representedCommentIds, ["new-staged"]);
  assert.deepEqual(mergedSnapshot.comments?.map((comment) => comment.id), ["new-staged", "published-prior"]);
  assert.ok(plan.payload);

  const calls: string[] = [];
  const receipt = await publishGitHubReview(
    fakePublishPi({ preflight: livePull(), post: { stdout: JSON.stringify({ id: 2000 }) }, calls }),
    "/repo",
    metadata,
    plan.payload,
    publishDependencies,
  );
  const publishedSnapshot = markGitHubReviewCommentsPublished(
    mergedSnapshot,
    plan.representedCommentIds,
    receipt,
    "2026-07-10T09:00:00Z",
  );

  assert.deepEqual(calls, [
    "gh GET repos/headout/magellan/pulls/646",
    "gh POST repos/headout/magellan/pulls/646/reviews",
  ]);
  assert.deepEqual(publishedSnapshot.comments?.map((comment) => ({ id: comment.id, status: comment.status })), [
    { id: "new-staged", status: "published" },
    { id: "published-prior", status: "published" },
  ]);
});

test("an incoming comment that reuses an authoritative published ID produces zero remote writes", async () => {
  const resolveSubmitted = (sessionStore as Record<string, unknown>).resolveSubmittedCommentsFromSnapshot;
  assert.equal(typeof resolveSubmitted, "function");
  if (typeof resolveSubmitted !== "function") return;

  const priorPublished: DiffReviewComment = {
    id: "published-prior",
    fileId: "file-1",
    scope: "git-diff",
    side: "modified",
    startLine: 42,
    endLine: null,
    body: "Authoritative published body.",
    status: "published",
    published: true,
    publishedAt: "2026-07-09T09:00:00Z",
  };
  const reusedIncoming: DiffReviewComment = {
    ...priorPublished,
    body: "Renderer attempted to reuse the ID.",
    status: "staged",
    published: false,
    publishedAt: undefined,
  };
  const mergedSnapshot = mergeAuthoritativePublishedComments({ comments: [reusedIncoming] }, [priorPublished]);
  const submit = payload();
  submit.comments = (resolveSubmitted as (
    comments: readonly DiffReviewComment[],
    snapshot: ReviewSessionSnapshot,
  ) => DiffReviewComment[])([reusedIncoming], mergedSnapshot);
  const plan = buildGitHubReviewPublishPlan({
    ...buildOptions(submit),
    reviewedHeadSha: "head-immutable-sha",
  });
  const calls: string[] = [];
  if (plan.payload != null) {
    await publishGitHubReview(
      fakePublishPi({ preflight: livePull(), calls }),
      "/repo",
      metadata,
      plan.payload,
      publishDependencies,
    );
  }

  assert.equal(plan.payload, null);
  assert.deepEqual(plan.errors.map(({ code, commentId }) => ({ code, commentId })), [
    { code: "already-published", commentId: "published-prior" },
  ]);
  assert.deepEqual(calls, []);
});
