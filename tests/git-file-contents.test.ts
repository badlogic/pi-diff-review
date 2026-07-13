import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadReviewFileContents } from "../src/git.js";
import type { ReviewFile } from "../src/types.js";

test("working-tree content loading propagates secure reader failures", async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-git-contents-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));
  await writeFile(join(repoRoot, "target.ts"), "export const target = true;\n", "utf8");
  await symlink("target.ts", join(repoRoot, "linked.ts"));
  const file: ReviewFile = {
    id: "linked.ts",
    path: "linked.ts",
    worktreeStatus: null,
    hasWorkingTreeFile: true,
    inGitDiff: false,
    inLastCommit: false,
    gitDiff: null,
    lastCommit: null,
    commitComparisons: {},
  };

  await assert.rejects(
    loadReviewFileContents({} as ExtensionAPI, repoRoot, file, "all-files"),
    /symbolic link.*linked\.ts/i,
  );
});
