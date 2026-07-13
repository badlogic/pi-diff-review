import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildGitHubPrReviewDataset, buildPrPrivateRefs, parseGitHubPrUrl } from "../src/sources/github-pr.js";

interface FakeExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function fakePi(outputs: Map<string, Partial<FakeExecResult>>, calls: string[]): ExtensionAPI {
  return {
    exec: async (command: string, args: string[]) => {
      const key = [command, ...args].join("\0");
      calls.push(key);
      const result = outputs.get(key);
      assert.ok(result, `unexpected command: ${command} ${args.join(" ")}`);
      return {
        code: 0,
        stdout: "",
        stderr: "",
        ...result,
      };
    },
  } as unknown as ExtensionAPI;
}

test("parses github pull request url", () => {
  assert.deepEqual(parseGitHubPrUrl("https://github.com/headout/magellan/pull/646"), {
    owner: "headout",
    repo: "magellan",
    number: 646,
    url: "https://github.com/headout/magellan/pull/646",
  });
});

test("parses devinreview-style github path only when host is github", () => {
  assert.throws(() => parseGitHubPrUrl("https://devinreview.com/headout/magellan/pull/646"), /Expected a github.com PR URL/);
});

test("rejects malformed pull request url", () => {
  assert.throws(() => parseGitHubPrUrl("https://github.com/headout/magellan/issues/646"), /Expected URL path/);
});

test("builds private refs outside the origin remote tracking namespace", () => {
  const refs = buildPrPrivateRefs({ owner: "headout", repo: "magellan", number: 646, url: "https://github.com/headout/magellan/pull/646" });
  assert.match(refs.baseRef, /^refs\/pi-diff-review-cockpit/);
  assert.match(refs.headRef, /^refs\/pi-diff-review-cockpit/);
  assert.equal(refs.baseRef.includes("refs/remotes/origin"), false);
  assert.equal(refs.headRef.includes("refs/remotes/origin"), false);
});

test("sanitizes private refs for unsafe owner and repo values", () => {
  const refs = buildPrPrivateRefs({ owner: "../head/out", repo: "..\\magellan", number: 646, url: "https://github.com/headout/magellan/pull/646" });

  assert.equal(refs.baseRef.includes(".."), false);
  assert.equal(refs.headRef.includes(".."), false);
  assert.match(refs.baseRef, /^refs\/pi-diff-review-cockpit\/github\/--head-out\/--magellan\/pr\/646\/base$/);
  assert.match(refs.headRef, /^refs\/pi-diff-review-cockpit\/github\/--head-out\/--magellan\/pr\/646\/head$/);
});

test("builds github pr dataset from immutable private-ref SHAs without creating a worktree", async () => {
  const ref = parseGitHubPrUrl("https://github.com/headout/magellan/pull/646");
  const privateRefs = buildPrPrivateRefs(ref);
  const calls: string[] = [];
  const outputs = new Map<string, Partial<FakeExecResult>>([
    [["git", "rev-parse", "--show-toplevel"].join("\0"), { stdout: "/repo\n" }],
    [["git", "remote", "get-url", "origin"].join("\0"), { stdout: "https://github.com/headout/magellan.git\n" }],
    [["gh", "pr", "view", ref.url, "--json", "number,title,body,author,baseRefName,headRefName,headRepositoryOwner,isDraft,state,url"].join("\0"), {
      stdout: JSON.stringify({
        number: 646,
        title: "QA dataset labeler",
        body: "Adds QA dataset labeler.",
        author: { login: "dev" },
        baseRefName: "main",
        headRefName: "feat/qa",
        headRepositoryOwner: { login: "fork-owner" },
        isDraft: false,
        state: "OPEN",
        url: ref.url,
      }),
    }],
    [["git", "fetch", "origin", `+refs/heads/main:${privateRefs.baseRef}`].join("\0"), { stdout: "" }],
    [["git", "fetch", "origin", `+pull/646/head:${privateRefs.headRef}`].join("\0"), { stdout: "" }],
    [["git", "rev-parse", "--verify", `${privateRefs.baseRef}^{commit}`].join("\0"), { stdout: "base-immutable-sha\n" }],
    [["git", "rev-parse", "--verify", `${privateRefs.headRef}^{commit}`].join("\0"), { stdout: "head-immutable-sha\n" }],
    [["git", "diff", "--find-renames", "-M", "--name-status", "base-immutable-sha...head-immutable-sha", "--"].join("\0"), {
      stdout: "A\tsrc/app/api/qa_api.py\n",
    }],
    [["git", "diff", "--find-renames", "-M", "--no-color", "base-immutable-sha...head-immutable-sha", "--"].join("\0"), {
      stdout: [
        "diff --git a/src/app/api/qa_api.py b/src/app/api/qa_api.py",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/app/api/qa_api.py",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
      ].join("\n"),
    }],
    [["git", "diff", "--find-renames", "-M", "--numstat", "-z", "base-immutable-sha...head-immutable-sha", "--"].join("\0"), {
      stdout: "2\t0\tsrc/app/api/qa_api.py\0",
    }],
    [["git", "ls-tree", "-r", "--name-only", "head-immutable-sha"].join("\0"), {
      stdout: "src/app/api/qa_api.py\n",
    }],
    [["git", "diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "head-immutable-sha"].join("\0"), {
      stdout: "A\tsrc/app/api/qa_api.py\n",
    }],
    [["git", "log", "--max-count=50", "--format=%H%x09%h%x09%s", "base-immutable-sha..head-immutable-sha"].join("\0"), {
      stdout: "",
    }],
  ]);

  const dataset = await buildGitHubPrReviewDataset(
    fakePi(outputs, calls),
    { cwd: "/repo/subdir" } as ExtensionCommandContext,
    ref.url,
  );

  assert.equal(dataset.repoRoot, "/repo");
  assert.equal(dataset.workingRoot, "/repo");
  assert.equal(dataset.source.baseRevision, "base-immutable-sha");
  assert.equal(dataset.source.headRevision, "head-immutable-sha");
  assert.deepEqual(dataset.analysisFileIds, [dataset.files[0]?.id]);
  assert.deepEqual(dataset.files.map((file) => file.path), ["src/app/api/qa_api.py"]);
  assert.equal(dataset.files[0]?.gitDiff?.addedLines, 2);
  assert.equal(dataset.files[0]?.gitDiff?.deletedLines, 0);
  assert.equal(calls.some((call) => call.includes("\0worktree\0")), false);
  assert.equal(calls.some((call) => call.includes("\0apply\0")), false);
  assert.equal(calls.some((call) => call.includes("fork-owner")), false);
});
