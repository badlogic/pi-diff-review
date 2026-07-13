import assert from "node:assert/strict";
import test from "node:test";
import {
  firstUnreviewedVisitInChapter,
  isFileCanvasActive,
  nextGuidedReviewDestination,
} from "../web/review-navigation-state.js";

const chapters = [
  {
    id: "contract",
    visits: [
      { id: "contract-runtime", fileId: "src/runtime.py" },
      { id: "contract-tests", fileId: "tests/runtime.py" },
    ],
  },
  {
    id: "cleanup",
    visits: [
      { id: "cleanup-runtime", fileId: "src/runtime.py" },
      { id: "cleanup-docs", fileId: "docs/runtime.md" },
    ],
  },
  {
    id: "release",
    visits: [
      { id: "release-notes", fileId: "docs/release.md" },
    ],
  },
];

test("a file is selected only when its diff canvas is active", () => {
  assert.equal(isFileCanvasActive("file", "file-1", "file-1"), true);
  assert.equal(isFileCanvasActive("chapter", "file-1", "file-1"), false);
  assert.equal(isFileCanvasActive("file", "file-2", "file-1"), false);
});

test("first unreviewed visit preserves semantic visit order", () => {
  assert.equal(firstUnreviewedVisitInChapter(chapters[0], {})?.id, "contract-runtime");
  assert.equal(
    firstUnreviewedVisitInChapter(chapters[0], { "contract-runtime": true })?.id,
    "contract-tests",
  );
  assert.equal(
    firstUnreviewedVisitInChapter(chapters[0], { "contract-runtime": true, "contract-tests": true }),
    null,
  );
});

test("guided review stays inside the current chapter while visits remain", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(chapters, { "contract-runtime": true }, "contract-runtime"),
    {
      kind: "visit",
      chapterId: "contract",
      visitId: "contract-tests",
      fileId: "tests/runtime.py",
    },
  );
});

test("guided review pauses on the next incomplete chapter overview", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      { "contract-runtime": true, "contract-tests": true },
      "contract-tests",
    ),
    { kind: "chapter", chapterId: "cleanup" },
  );
});

test("guided review skips complete later chapters", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      {
        "contract-runtime": true,
        "contract-tests": true,
        "cleanup-runtime": true,
        "cleanup-docs": true,
      },
      "contract-tests",
    ),
    { kind: "chapter", chapterId: "release" },
  );
});

test("guided review handles two visits for the same file by visit identity", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      {
        "contract-runtime": true,
        "contract-tests": true,
        "cleanup-runtime": true,
      },
      "cleanup-runtime",
    ),
    {
      kind: "visit",
      chapterId: "cleanup",
      visitId: "cleanup-docs",
      fileId: "docs/runtime.md",
    },
  );
});

test("out-of-order completion wraps to an earlier incomplete chapter", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      {
        "contract-runtime": true,
        "cleanup-runtime": true,
        "cleanup-docs": true,
        "release-notes": true,
      },
      "release-notes",
    ),
    { kind: "chapter", chapterId: "contract" },
  );
});

test("the final outstanding visit advances to the overall AI result", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      {
        "contract-runtime": true,
        "contract-tests": true,
        "cleanup-runtime": true,
        "cleanup-docs": true,
        "release-notes": true,
      },
      "release-notes",
    ),
    { kind: "ai-review" },
  );
});

test("an unknown current visit never guesses a destination", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(chapters, {}, "missing-visit"),
    { kind: "stay", reason: "active-visit-not-found" },
  );
});
