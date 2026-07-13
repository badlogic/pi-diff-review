import assert from "node:assert/strict";
import test from "node:test";
import { extractReviewChangeUnits, validateChangeUnitSubdivision } from "../src/review-change-units.js";
import type { ReviewChangeUnit, ReviewFile } from "../src/types.js";

function file(): ReviewFile {
  return {
    id: "src/runtime.ts",
    path: "src/runtime.ts",
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    gitDiff: {
      status: "modified",
      oldPath: "src/runtime.ts",
      newPath: "src/runtime.ts",
      displayPath: "src/runtime.ts",
      hasOriginal: true,
      hasModified: true,
      addedLines: 3,
      deletedLines: 2,
      commentableOriginalLines: [{ start: 10, end: 11 }],
      commentableModifiedLines: [{ start: 10, end: 12 }],
    },
    lastCommit: null,
    commitComparisons: {},
  };
}

const patch = [
  "diff --git a/src/runtime.ts b/src/runtime.ts",
  "--- a/src/runtime.ts",
  "+++ b/src/runtime.ts",
  "@@ -9,4 +9,5 @@ export async function run()",
  " context",
  "-oldOne();",
  "-oldTwo();",
  "+await nextOne();",
  "+await nextTwo();",
  "+await cleanup();",
  " context",
].join("\n");

test("extracts a stable replacement unit with exact changed-line ownership", () => {
  const input = { sourceFingerprint: "sha256:a", file: file(), patch, commitIds: ["c1"] };
  const first = extractReviewChangeUnits(input);
  const second = extractReviewChangeUnits(input);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.symbol, "export async function run()");
  assert.deepEqual(first[0]?.ranges, [
    { fileId: "src/runtime.ts", path: "src/runtime.ts", side: "original", startLine: 10, endLine: 11 },
    { fileId: "src/runtime.ts", path: "src/runtime.ts", side: "modified", startLine: 10, endLine: 12 },
  ]);

  const changed = extractReviewChangeUnits({ ...input, patch: patch.replace("cleanup", "dispose") });
  assert.notEqual(changed[0]?.id, first[0]?.id);
});

test("does not create a range-less unit for an empty added file", () => {
  const emptyFile: ReviewFile = {
    ...file(),
    id: "src/empty.ts",
    path: "src/empty.ts",
    worktreeStatus: "added",
    gitDiff: {
      status: "added",
      oldPath: null,
      newPath: "src/empty.ts",
      displayPath: "src/empty.ts",
      hasOriginal: false,
      hasModified: true,
      addedLines: 0,
      deletedLines: 0,
      commentableOriginalLines: [],
      commentableModifiedLines: [],
    },
  };
  const emptyPatch = [
    "diff --git a/src/empty.ts b/src/empty.ts",
    "new file mode 100644",
    "index 00000000..e69de29b",
  ].join("\n");

  assert.deepEqual(extractReviewChangeUnits({
    sourceFingerprint: "sha256:a",
    file: emptyFile,
    patch: emptyPatch,
    commitIds: ["c1"],
  }), []);
});

test("validates child subdivisions only when they exactly preserve parent coverage", () => {
  const parent = extractReviewChangeUnits({ sourceFingerprint: "sha256:a", file: file(), patch, commitIds: [] })[0]!;
  const child = (id: string, startLine: number, endLine: number): ReviewChangeUnit => ({
    ...parent,
    id,
    ranges: [{ fileId: parent.fileId, path: parent.path, side: "modified", startLine, endLine }],
  });

  const modifiedOnlyParent: ReviewChangeUnit = {
    ...parent,
    ranges: parent.ranges.filter((range) => range.side === "modified"),
  };
  assert.equal(validateChangeUnitSubdivision(modifiedOnlyParent, [child("a", 10, 10), child("b", 11, 12)]), true);
  assert.equal(validateChangeUnitSubdivision(modifiedOnlyParent, [child("a", 10, 11), child("b", 11, 12)]), false);
  assert.equal(validateChangeUnitSubdivision(modifiedOnlyParent, [child("a", 10, 10), child("b", 12, 12)]), false);
  assert.equal(validateChangeUnitSubdivision(modifiedOnlyParent, [child("a", 9, 12)]), false);
});
