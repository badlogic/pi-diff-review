import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getReviewWindowData, getRevisionDiffReviewData, loadReviewFileContents } from "../src/git.js";

interface FakeExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function fakePi(outputs: Map<string, Partial<FakeExecResult>>): ExtensionAPI {
  return {
    exec: async (command: string, args: string[]) => {
      assert.equal(command, "git");
      const result = outputs.get(args.join("\0"));
      assert.ok(result, `unexpected git args: ${args.join(" ")}`);
      return {
        code: 0,
        stdout: "",
        stderr: "",
        ...result,
      };
    },
  } as unknown as ExtensionAPI;
}

test("attaches commentable git-diff hunk ranges to worktree comparisons", async () => {
  const outputs = new Map<string, Partial<FakeExecResult>>([
    [["rev-parse", "--show-toplevel"].join("\0"), { stdout: "/repo\n" }],
    [["rev-parse", "--verify", "HEAD"].join("\0"), { stdout: "HEAD\n" }],
    [["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"].join("\0"), {
      stdout: [
        "M\tmodified.ts",
        "A\tadded.ts",
        "D\tdeleted.ts",
        "R100\told-name.ts\trenamed.ts",
      ].join("\n"),
    }],
    [["diff", "--find-renames", "-M", "--no-color", "HEAD", "--"].join("\0"), {
      stdout: [
        "diff --git a/modified.ts b/modified.ts",
        "--- a/modified.ts",
        "+++ b/modified.ts",
        "@@ -5 +5,2 @@",
        "-old",
        "+new",
        "+newer",
        "diff --git a/added.ts b/added.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/added.ts",
        "@@ -0,0 +1,3 @@",
        "+one",
        "+two",
        "+three",
        "diff --git a/deleted.ts b/deleted.ts",
        "deleted file mode 100644",
        "--- a/deleted.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
        "diff --git a/old-name.ts b/renamed.ts",
        "similarity index 80%",
        "rename from old-name.ts",
        "rename to renamed.ts",
        "--- a/old-name.ts",
        "+++ b/renamed.ts",
        "@@ -20 +21 @@",
        "-old",
        "+new",
      ].join("\n"),
    }],
    [["diff", "--find-renames", "-M", "--numstat", "-z", "HEAD", "--"].join("\0"), {
      stdout: ["2\t1\tmodified.ts", "3\t0\tadded.ts", "0\t2\tdeleted.ts", "1\t1\t", "old-name.ts", "renamed.ts", ""].join("\0"),
    }],
    [["ls-files", "--others", "--exclude-standard"].join("\0"), { stdout: "" }],
    [["ls-files", "--cached"].join("\0"), { stdout: "modified.ts\nadded.ts\nrenamed.ts\n" }],
    [["ls-files", "--deleted"].join("\0"), { stdout: "deleted.ts\n" }],
    [["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"].join("\0"), { stdout: "" }],
    [["log", "--max-count=50", "--format=%H%x09%h%x09%s"].join("\0"), { stdout: "" }],
  ]);

  const { files } = await getReviewWindowData(fakePi(outputs), "/repo");
  const byPath = new Map(files.map((file) => [file.path, file]));

  assert.deepEqual(byPath.get("modified.ts")?.gitDiff?.commentableOriginalLines, [{ start: 5, end: 5 }]);
  assert.deepEqual(byPath.get("modified.ts")?.gitDiff?.commentableModifiedLines, [{ start: 5, end: 6 }]);
  assert.deepEqual(byPath.get("added.ts")?.gitDiff?.commentableOriginalLines, []);
  assert.deepEqual(byPath.get("added.ts")?.gitDiff?.commentableModifiedLines, [{ start: 1, end: 3 }]);
  assert.deepEqual(byPath.get("deleted.ts")?.gitDiff?.commentableOriginalLines, [{ start: 1, end: 2 }]);
  assert.deepEqual(byPath.get("deleted.ts")?.gitDiff?.commentableModifiedLines, []);
  assert.deepEqual(byPath.get("renamed.ts")?.gitDiff?.commentableOriginalLines, [{ start: 20, end: 20 }]);
  assert.deepEqual(byPath.get("renamed.ts")?.gitDiff?.commentableModifiedLines, [{ start: 21, end: 21 }]);
  assert.equal(byPath.get("renamed.ts")?.gitDiff?.addedLines, 1);
  assert.equal(byPath.get("renamed.ts")?.gitDiff?.deletedLines, 1);
});

test("index git-diff mode ignores unrelated unstaged worktree changes", async () => {
  const outputs = new Map<string, Partial<FakeExecResult>>([
    [["rev-parse", "--show-toplevel"].join("\0"), { stdout: "/repo\n" }],
    [["rev-parse", "--verify", "HEAD"].join("\0"), { stdout: "HEAD\n" }],
    [["diff", "--cached", "--find-renames", "-M", "--name-status", "HEAD", "--"].join("\0"), {
      stdout: "M\tpr-file.ts\n",
    }],
    [["diff", "--cached", "--find-renames", "-M", "--no-color", "HEAD", "--"].join("\0"), {
      stdout: [
        "diff --git a/pr-file.ts b/pr-file.ts",
        "--- a/pr-file.ts",
        "+++ b/pr-file.ts",
        "@@ -10 +10,2 @@",
        "-old",
        "+new",
        "+newer",
      ].join("\n"),
    }],
    [["diff", "--cached", "--find-renames", "-M", "--numstat", "-z", "HEAD", "--"].join("\0"), {
      stdout: "2\t1\tpr-file.ts\0",
    }],
    [["ls-files", "--cached"].join("\0"), { stdout: "pr-file.ts\nlarge-dirty.csv\n" }],
    [["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"].join("\0"), { stdout: "" }],
    [["log", "--max-count=50", "--format=%H%x09%h%x09%s"].join("\0"), { stdout: "" }],
  ]);

  const { files } = await getReviewWindowData(fakePi(outputs), "/repo", { gitDiffMode: "index" });
  const diffFiles = files.filter((file) => file.inGitDiff);

  assert.deepEqual(diffFiles.map((file) => file.path), ["pr-file.ts"]);
  assert.equal(diffFiles[0]?.gitDiff?.addedLines, 2);
  assert.equal(diffFiles[0]?.gitDiff?.deletedLines, 1);
  assert.deepEqual(diffFiles[0]?.gitDiff?.commentableModifiedLines, [{ start: 10, end: 11 }]);
  assert.deepEqual(diffFiles[0]?.gitDiff?.commentableOriginalLines, [{ start: 10, end: 10 }]);
});

test("revision diff review data does not require a checkout worktree", async () => {
  const outputs = new Map<string, Partial<FakeExecResult>>([
    [["diff", "--find-renames", "-M", "--name-status", "refs/review/base...refs/review/head", "--"].join("\0"), {
      stdout: [
        "M\tmodified.ts",
        "A\tadded.ts",
        "D\tdeleted.ts",
      ].join("\n"),
    }],
    [["diff", "--find-renames", "-M", "--no-color", "refs/review/base...refs/review/head", "--"].join("\0"), {
      stdout: [
        "diff --git a/modified.ts b/modified.ts",
        "--- a/modified.ts",
        "+++ b/modified.ts",
        "@@ -8 +8,2 @@",
        "-old",
        "+new",
        "+newer",
        "diff --git a/added.ts b/added.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/added.ts",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
        "diff --git a/deleted.ts b/deleted.ts",
        "deleted file mode 100644",
        "--- a/deleted.ts",
        "+++ /dev/null",
        "@@ -4,2 +0,0 @@",
        "-one",
        "-two",
      ].join("\n"),
    }],
    [["diff", "--find-renames", "-M", "--numstat", "-z", "refs/review/base...refs/review/head", "--"].join("\0"), {
      stdout: ["2\t1\tmodified.ts", "2\t0\tadded.ts", "0\t2\tdeleted.ts", ""].join("\0"),
    }],
    [["ls-tree", "-r", "--name-only", "refs/review/head"].join("\0"), {
      stdout: "modified.ts\nadded.ts\nunchanged.ts\n",
    }],
    [["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "refs/review/head"].join("\0"), {
      stdout: "M\tmodified.ts\n",
    }],
    [["log", "--max-count=50", "--format=%H%x09%h%x09%s", "refs/review/base..refs/review/head"].join("\0"), {
      stdout: "abc123\tabc123\tUpdate PR files\n",
    }],
    [["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "abc123"].join("\0"), {
      stdout: "M\tmodified.ts\n",
    }],
    [["show", "refs/review/base:modified.ts"].join("\0"), { stdout: "old\n" }],
    [["show", "refs/review/head:modified.ts"].join("\0"), { stdout: "new\nnewer\n" }],
    [["show", "refs/review/head:unchanged.ts"].join("\0"), { stdout: "same\n" }],
  ]);

  const pi = fakePi(outputs);
  const { files, commits } = await getRevisionDiffReviewData(pi, "/repo", "refs/review/base", "refs/review/head");
  const byPath = new Map(files.map((file) => [file.path, file]));

  assert.deepEqual(commits.map((commit) => commit.sha), ["abc123"]);
  assert.deepEqual(files.filter((file) => file.inGitDiff).map((file) => file.path), ["added.ts", "deleted.ts", "modified.ts"]);
  assert.equal(byPath.get("unchanged.ts")?.inGitDiff, false);
  assert.equal(byPath.get("deleted.ts")?.hasWorkingTreeFile, false);
  assert.deepEqual(byPath.get("modified.ts")?.gitDiff?.commentableOriginalLines, [{ start: 8, end: 8 }]);
  assert.deepEqual(byPath.get("modified.ts")?.gitDiff?.commentableModifiedLines, [{ start: 8, end: 9 }]);

  const modified = byPath.get("modified.ts");
  assert.ok(modified);
  const contents = await loadReviewFileContents(pi, "/repo", modified, "git-diff", undefined, {
    revisionDiff: { baseRevision: "refs/review/base", headRevision: "refs/review/head" },
  });
  assert.deepEqual(contents, {
    originalContent: "old\n",
    modifiedContent: "new\nnewer\n",
  });

  const unchanged = byPath.get("unchanged.ts");
  assert.ok(unchanged);
  const allFileContents = await loadReviewFileContents(pi, "/repo", unchanged, "all-files", undefined, {
    revisionDiff: { baseRevision: "refs/review/base", headRevision: "refs/review/head" },
  });
  assert.deepEqual(allFileContents, {
    originalContent: "same\n",
    modifiedContent: "same\n",
  });
});

test("revision diffs keep canonical stats separate from exact comment anchors", async () => {
  const range = "refs/review/base...refs/review/head";
  const outputs = new Map<string, Partial<FakeExecResult>>([
    [["diff", "--find-renames", "-M", "--name-status", range, "--"].join("\0"), {
      stdout: "M\tlarge.py\n",
    }],
    [["diff", "--find-renames", "-M", "--no-color", range, "--"].join("\0"), {
      stdout: [
        "diff --git a/large.py b/large.py",
        "--- a/large.py",
        "+++ b/large.py",
        "@@ -10,4 +10,4 @@",
        " context one",
        "-old one",
        "+new one",
        " context two",
        "-old two",
        "+new two",
      ].join("\n"),
    }],
    [["diff", "--find-renames", "-M", "--numstat", "-z", range, "--"].join("\0"), {
      stdout: "2\t2\tlarge.py\0",
    }],
    [["ls-tree", "-r", "--name-only", "refs/review/head"].join("\0"), { stdout: "large.py\n" }],
    [["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "refs/review/head"].join("\0"), { stdout: "" }],
    [["log", "--max-count=50", "--format=%H%x09%h%x09%s", "refs/review/base..refs/review/head"].join("\0"), { stdout: "" }],
  ]);

  const { files } = await getRevisionDiffReviewData(fakePi(outputs), "/repo", "refs/review/base", "refs/review/head");
  const comparison = files.find((file) => file.path === "large.py")?.gitDiff;

  assert.ok(comparison);
  assert.equal(comparison.addedLines, 2);
  assert.equal(comparison.deletedLines, 2);
  assert.deepEqual(comparison.commentableOriginalLines, [{ start: 11, end: 11 }, { start: 13, end: 13 }]);
  assert.deepEqual(comparison.commentableModifiedLines, [{ start: 11, end: 11 }, { start: 13, end: 13 }]);
});

test("revision diffs reject comment anchors that disagree with canonical stats", async () => {
  const range = "refs/review/base...refs/review/head";
  const outputs = new Map<string, Partial<FakeExecResult>>([
    [["diff", "--find-renames", "-M", "--name-status", range, "--"].join("\0"), {
      stdout: "M\tlarge.py\n",
    }],
    [["diff", "--find-renames", "-M", "--no-color", range, "--"].join("\0"), {
      stdout: [
        "diff --git a/large.py b/large.py",
        "--- a/large.py",
        "+++ b/large.py",
        "@@ -10,2 +10,2 @@",
        "-old one",
        "-old two",
        "+new one",
        "+new two",
      ].join("\n"),
    }],
    [["diff", "--find-renames", "-M", "--numstat", "-z", range, "--"].join("\0"), {
      stdout: "1\t1\tlarge.py\0",
    }],
    [["ls-tree", "-r", "--name-only", "refs/review/head"].join("\0"), { stdout: "large.py\n" }],
    [["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "refs/review/head"].join("\0"), { stdout: "" }],
    [["log", "--max-count=50", "--format=%H%x09%h%x09%s", "refs/review/base..refs/review/head"].join("\0"), { stdout: "" }],
  ]);

  await assert.rejects(
    getRevisionDiffReviewData(fakePi(outputs), "/repo", "refs/review/base", "refs/review/head"),
    /Diff metadata for large\.py is inconsistent/,
  );
});
