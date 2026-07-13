import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReviewFilePatchLoader } from "../src/file-patch.js";
import { buildReviewDiffFingerprint } from "../src/session-store.js";
import type { ReviewDataset } from "../src/sources/types.js";
import type { ReviewFile } from "../src/types.js";

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGitProcess(args: string[], cwd: string, timeout?: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout }, (error, stdout, stderr) => {
      const exitCode = error == null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

async function requireGit(args: string[], cwd: string): Promise<string> {
  const result = await runGitProcess(args, cwd);
  assert.equal(result.code, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function realGitPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options: { cwd?: string; timeout?: number }) => {
      assert.equal(command, "git");
      assert.ok(options.cwd);
      return runGitProcess(args, options.cwd, options.timeout);
    },
  } as unknown as ExtensionAPI;
}

async function createRootCommitRepository(t: test.TestContext): Promise<{ repoRoot: string; rootSha: string }> {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-review-root-commit-"));
  t.after(async () => rm(sandbox, { recursive: true, force: true }));
  const repoRoot = join(sandbox, "repo");
  await requireGit(["init", "--quiet", repoRoot], sandbox);
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await writeFile(join(repoRoot, "src/git.ts"), "export const root = true;\n", "utf8");
  await requireGit(["add", "src/git.ts"], repoRoot);
  await requireGit([
    "-c", "user.name=PI Review Tests",
    "-c", "user.email=pi-review-tests@example.invalid",
    "commit", "--quiet", "-m", "root commit",
  ], repoRoot);
  const rootSha = (await requireGit(["rev-parse", "HEAD"], repoRoot)).trim();
  assert.equal((await requireGit(["rev-list", "--count", "HEAD"], repoRoot)).trim(), "1");
  return { repoRoot, rootSha };
}

function reviewFile(overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    id: "src/example.ts",
    path: "src/example.ts",
    worktreeStatus: null,
    hasWorkingTreeFile: true,
    inGitDiff: false,
    inLastCommit: false,
    gitDiff: null,
    lastCommit: null,
    commitComparisons: {},
    ...overrides,
  };
}

function modifiedGitDiffFile(): ReviewFile {
  return reviewFile({
    worktreeStatus: "modified",
    inGitDiff: true,
    gitDiff: {
      status: "modified",
      oldPath: "src/example.ts",
      newPath: "src/example.ts",
      displayPath: "src/example.ts",
      hasOriginal: true,
      hasModified: true,
    },
  });
}

function addedGitDiffFile(path = "src/new.ts"): ReviewFile {
  return reviewFile({
    id: path,
    path,
    worktreeStatus: "added",
    inGitDiff: true,
    gitDiff: {
      status: "added",
      oldPath: null,
      newPath: path,
      displayPath: path,
      hasOriginal: false,
      hasModified: true,
    },
  });
}

function lastCommitFile(): ReviewFile {
  return reviewFile({
    inLastCommit: true,
    lastCommit: {
      status: "modified",
      oldPath: "src/example.ts",
      newPath: "src/example.ts",
      displayPath: "src/example.ts",
      hasOriginal: true,
      hasModified: true,
    },
  });
}

test("returns an empty patch when the file has no comparison", async () => {
  const pi = {
    exec: async () => {
      assert.fail("git must not run without a comparison");
    },
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: "/repo",
    workingRoot: "/repo",
  });

  assert.equal(await loadPatch(reviewFile()), "");
});

test("returns a successful non-empty git diff for a changed file", async () => {
  const pi = {
    exec: async (command: string, args: string[], options: { cwd?: string }) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["diff", "--no-color", "--unified=80", "HEAD", "--", "src/example.ts"]);
      assert.equal(options.cwd, "/worktree");
      return {
        code: 0,
        stdout: "diff --git a/src/example.ts b/src/example.ts\n",
        stderr: "",
      };
    },
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: "/repo",
    workingRoot: "/worktree",
  });
  assert.equal(await loadPatch(modifiedGitDiffFile()), "diff --git a/src/example.ts b/src/example.ts\n");
});

test("throws useful diagnostics when git diff exits nonzero", async () => {
  const pi = {
    exec: async () => ({
      code: 128,
      stdout: "",
      stderr: "fatal: bad revision 'HEAD'\n",
    }),
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: "/repo",
    workingRoot: "/worktree",
  });

  await assert.rejects(
    loadPatch(modifiedGitDiffFile()),
    (error: Error) => {
      assert.match(error.message, /src\/example\.ts/);
      assert.match(error.message, /git diff/);
      assert.match(error.message, /code 128/);
      assert.match(error.message, /fatal: bad revision 'HEAD'/);
      return true;
    },
  );
});

test("throws when a represented change has a successful empty git diff", async () => {
  const pi = {
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: "/repo",
    workingRoot: "/worktree",
  });

  await assert.rejects(
    loadPatch(modifiedGitDiffFile()),
    (error: Error) => {
      assert.match(error.message, /empty/i);
      assert.match(error.message, /git diff/i);
      assert.match(error.message, /src\/example\.ts/);
      return true;
    },
  );
});

test("loads an untracked added file through the repository reader", async (t) => {
  const workingRoot = await mkdtemp(join(tmpdir(), "pi-review-file-patch-"));
  t.after(async () => rm(workingRoot, { recursive: true, force: true }));
  await mkdir(join(workingRoot, "src"));
  await writeFile(join(workingRoot, "src", "new.ts"), "export const added = true;\n", "utf8");
  const pi = {
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: workingRoot,
    workingRoot,
  });

  assert.equal(await loadPatch(addedGitDiffFile()), "export const added = true;\n");
});

test("returns and structurally fingerprints an empty untracked regular file", async (t) => {
  const workingRoot = await mkdtemp(join(tmpdir(), "pi-review-file-patch-"));
  t.after(async () => rm(workingRoot, { recursive: true, force: true }));
  await mkdir(join(workingRoot, "src"));
  await writeFile(join(workingRoot, "src", "new.ts"), "", "utf8");
  const pi = {
    exec: async (_command: string, args: string[]) => args[0] === "rev-parse"
      ? { code: 0, stdout: "base-sha\n", stderr: "" }
      : { code: 0, stdout: "", stderr: "" },
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: workingRoot,
    workingRoot,
  });
  const file = addedGitDiffFile();
  const dataset: ReviewDataset = {
    repoRoot: workingRoot,
    workingRoot,
    files: [file],
    analysisFileIds: [file.id],
    commits: [],
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot: workingRoot,
      workingRoot,
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
  };

  assert.equal(await loadPatch(file), "");
  const first = await buildReviewDiffFingerprint(pi, dataset, loadPatch);
  const second = await buildReviewDiffFingerprint(pi, dataset, loadPatch);
  assert.deepEqual(first.files[0], {
    fileId: "src/new.ts",
    path: "src/new.ts",
    displayPath: "src/new.ts",
    status: "added",
    oldPath: null,
    newPath: "src/new.ts",
    patchHash: first.files[0]?.patchHash,
  });
  const structuralFallback = JSON.stringify({
    comparison: {
      displayPath: "src/new.ts",
      hasModified: true,
      hasOriginal: false,
      newPath: "src/new.ts",
      oldPath: null,
      status: "added",
    },
    id: "src/new.ts",
    path: "src/new.ts",
    worktreeStatus: "added",
  });
  assert.equal(first.files[0]?.patchHash, createHash("sha256").update(structuralFallback).digest("hex"));
  assert.equal(first.hash, second.hash);
});

test("throws useful diagnostics when an added revision fallback git show exits nonzero", async () => {
  const calls: string[][] = [];
  const pi = {
    exec: async (command: string, args: string[], options: { cwd?: string }) => {
      assert.equal(command, "git");
      assert.equal(options.cwd, "/repo");
      calls.push(args);
      if (args[0] === "diff") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 128, stdout: "", stderr: "fatal: path does not exist in revision\n" };
    },
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: "/repo",
    workingRoot: "/worktree",
    revisionDiff: {
      baseRevision: "refs/review/base",
      headRevision: "refs/review/head",
    },
  });

  await assert.rejects(
    loadPatch(addedGitDiffFile()),
    (error: Error) => {
      assert.match(error.message, /src\/new\.ts/);
      assert.match(error.message, /git show/);
      assert.match(error.message, /code 128/);
      assert.match(error.message, /fatal: path does not exist in revision/);
      return true;
    },
  );
  assert.deepEqual(calls, [
    ["diff", "--no-color", "--unified=80", "refs/review/base...refs/review/head", "--", "src/new.ts"],
    ["show", "refs/review/head:src/new.ts"],
  ]);
});

test("throws when an added revision fallback git show is empty", async () => {
  const pi = {
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: "/repo",
    workingRoot: "/worktree",
    revisionDiff: {
      baseRevision: "refs/review/base",
      headRevision: "refs/review/head",
    },
  });

  await assert.rejects(
    loadPatch(addedGitDiffFile()),
    (error: Error) => {
      assert.match(error.message, /git show/i);
      assert.match(error.message, /empty/i);
      assert.match(error.message, /src\/new\.ts/);
      return true;
    },
  );
});

test("loads a non-empty last-commit patch", async () => {
  const pi = {
    exec: async (_command: string, args: string[]) => {
      assert.deepEqual(args, ["show", "--format=", "--no-color", "--unified=80", "HEAD", "--", "src/example.ts"]);
      return {
        code: 0,
        stdout: "diff --git a/src/example.ts b/src/example.ts\n",
        stderr: "",
      };
    },
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: "/repo",
    workingRoot: "/worktree",
  });

  assert.equal(await loadPatch(lastCommitFile()), "diff --git a/src/example.ts b/src/example.ts\n");
});

test("loads last-commit patches when the selected head is a root commit", async (t) => {
  const { repoRoot, rootSha } = await createRootCommitRepository(t);
  const file = reviewFile({
    id: "src/git.ts",
    path: "src/git.ts",
    hasWorkingTreeFile: true,
    inLastCommit: true,
    lastCommit: {
      status: "added",
      oldPath: null,
      newPath: "src/git.ts",
      displayPath: "src/git.ts",
      hasOriginal: false,
      hasModified: true,
    },
  });

  await t.test("local HEAD", async () => {
    const loadPatch = createReviewFilePatchLoader(realGitPi(), {
      repoRoot,
      workingRoot: repoRoot,
    });
    assert.match(await loadPatch(file), /diff --git a\/src\/git\.ts b\/src\/git\.ts/);
  });

  await t.test("revision head", async () => {
    const loadPatch = createReviewFilePatchLoader(realGitPi(), {
      repoRoot,
      workingRoot: repoRoot,
      revisionDiff: {
        baseRevision: rootSha,
        headRevision: rootSha,
      },
    });
    assert.match(await loadPatch(file), /diff --git a\/src\/git\.ts b\/src\/git\.ts/);
  });
});

test("does not use the working-tree fallback for an added last-commit file", async (t) => {
  const workingRoot = await mkdtemp(join(tmpdir(), "pi-review-file-patch-"));
  t.after(async () => rm(workingRoot, { recursive: true, force: true }));
  await writeFile(join(workingRoot, "new.ts"), "unrelated working tree content\n", "utf8");
  const pi = {
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: workingRoot,
    workingRoot,
  });
  const file = reviewFile({
    id: "new.ts",
    path: "new.ts",
    inLastCommit: true,
    lastCommit: {
      status: "added",
      oldPath: null,
      newPath: "new.ts",
      displayPath: "new.ts",
      hasOriginal: false,
      hasModified: true,
    },
  });

  await assert.rejects(
    loadPatch(file),
    /empty patch.*represented change/i,
  );
});

test("loads a non-empty patch for a commit-only comparison", async () => {
  const pi = {
    exec: async (_command: string, args: string[]) => {
      assert.deepEqual(args, ["diff", "--no-color", "--unified=80", "HEAD", "--", "src/example.ts"]);
      return {
        code: 0,
        stdout: "diff --git a/src/example.ts b/src/example.ts\n",
        stderr: "",
      };
    },
  } as unknown as ExtensionAPI;
  const loadPatch = createReviewFilePatchLoader(pi, {
    repoRoot: "/repo",
    workingRoot: "/worktree",
  });
  const file = reviewFile({
    commitComparisons: {
      abc123: {
        status: "modified",
        oldPath: "src/example.ts",
        newPath: "src/example.ts",
        displayPath: "src/example.ts",
        hasOriginal: true,
        hasModified: true,
      },
    },
  });

  assert.equal(await loadPatch(file), "diff --git a/src/example.ts b/src/example.ts\n");
});
