import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchGitHubReviewContext } from "../src/github-review-context.js";

function connection(nodes: unknown[], endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor != null, endCursor } };
}

function comment(id: string) {
  return {
    id,
    author: { login: "reviewer" },
    body: `Body ${id}`,
    createdAt: "2026-07-10T10:00:00Z",
    url: `https://github.com/o/r/pull/1#${id}`,
  };
}

function fakePi(responses: Record<string, unknown[]>): ExtensionAPI {
  const offsets = new Map<string, number>();
  return {
    exec: async (command: string, args: string[]) => {
      assert.equal(command, "gh");
      const query = args.find((arg) => arg.startsWith("query="))?.slice("query=".length) ?? "";
      const operation = Object.keys(responses).find((name) => query.includes(`query ${name}`));
      assert.ok(operation, `unexpected GraphQL query: ${query.slice(0, 80)}`);
      const index = offsets.get(operation) ?? 0;
      offsets.set(operation, index + 1);
      const value = responses[operation]?.[index];
      assert.notEqual(value, undefined, `missing response ${operation}[${index}]`);
      return { code: 0, stdout: JSON.stringify(value), stderr: "" };
    },
  } as unknown as ExtensionAPI;
}

const source = { owner: "o", repo: "r", pullNumber: 1, reviewedHeadSha: "head-sha" };

test("fetches and deduplicates every GitHub review context connection", async () => {
  const thread = {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    diffSide: "RIGHT",
    line: 12,
    originalLine: null,
    comments: connection([comment("reply-1")], "reply-cursor"),
  };
  const pi = fakePi({
    ConversationComments: [
      { data: { repository: { pullRequest: { headRefOid: "head-sha", comments: connection([comment("issue-1")], "issue-cursor") } } } },
      { data: { repository: { pullRequest: { headRefOid: "head-sha", comments: connection([comment("issue-1"), comment("issue-2")]) } } } },
    ],
    ReviewSummaries: [
      { data: { repository: { pullRequest: { headRefOid: "head-sha", reviews: connection([{ ...comment("review-1"), state: "APPROVED" }]) } } } },
    ],
    ReviewThreads: [
      { data: { repository: { pullRequest: { headRefOid: "head-sha", reviewThreads: connection([thread]) } } } },
    ],
    ThreadComments: [
      { data: { node: { comments: connection([comment("reply-2")]) } } },
    ],
  });

  const result = await fetchGitHubReviewContext(pi, "/repo", source);

  assert.equal(result.remoteHeadSha, "head-sha");
  assert.deepEqual(result.conversationComments.map((item) => item.id), ["issue-1", "issue-2"]);
  assert.deepEqual(result.reviews.map((item) => item.id), ["review-1"]);
  assert.deepEqual(result.threads.map((item) => item.id), ["thread-1"]);
  assert.deepEqual(result.threads[0]?.comments.map((item) => item.id), ["reply-1", "reply-2"]);
  assert.equal(result.threads[0]?.side, "modified");
});

test("skips malformed siblings and records bounded diagnostics", async () => {
  const pi = fakePi({
    ConversationComments: [{ data: { repository: { pullRequest: { headRefOid: "head-sha", comments: connection([comment("valid"), { id: "broken" }]) } } } }],
    ReviewSummaries: [{ data: { repository: { pullRequest: { headRefOid: "head-sha", reviews: connection([]) } } } }],
    ReviewThreads: [{ data: { repository: { pullRequest: { headRefOid: "head-sha", reviewThreads: connection([{
      id: "thread-valid",
      isResolved: true,
      isOutdated: true,
      path: "src/a.ts",
      diffSide: "LEFT",
      line: null,
      originalLine: 8,
      comments: connection([comment("reply")]),
    }, { id: "broken-thread" }]) } } } }],
  });

  const result = await fetchGitHubReviewContext(pi, "/repo", source);

  assert.deepEqual(result.conversationComments.map((item) => item.id), ["valid"]);
  assert.deepEqual(result.threads.map((item) => item.id), ["thread-valid"]);
  assert.equal(result.threads[0]?.side, "original");
  assert.match(result.diagnostics.join("\n"), /Skipped malformed conversation comment/);
  assert.match(result.diagnostics.join("\n"), /Skipped malformed review thread/);
});

test("fails closed when a top-level connection repeats its cursor", async () => {
  const pi = fakePi({
    ConversationComments: [
      { data: { repository: { pullRequest: { headRefOid: "head-sha", comments: connection([], "same-cursor") } } } },
      { data: { repository: { pullRequest: { headRefOid: "head-sha", comments: connection([], "same-cursor") } } } },
    ],
  });

  await assert.rejects(
    fetchGitHubReviewContext(pi, "/repo", source),
    /pagination repeated a cursor/,
  );
});

test("fails closed when the pull request head changes between connections", async () => {
  const pi = fakePi({
    ConversationComments: [{ data: { repository: { pullRequest: { headRefOid: "head-sha", comments: connection([]) } } } }],
    ReviewSummaries: [{ data: { repository: { pullRequest: { headRefOid: "new-head", reviews: connection([]) } } } }],
  });

  await assert.rejects(
    fetchGitHubReviewContext(pi, "/repo", source),
    /head changed while review context was loading/,
  );
});

test("rejects invalid GraphQL JSON without exposing it as context", async () => {
  const pi = {
    exec: async () => ({ code: 0, stdout: "{not-json", stderr: "" }),
  } as unknown as ExtensionAPI;

  await assert.rejects(
    fetchGitHubReviewContext(pi, "/repo", source),
    /returned invalid JSON/,
  );
});
