import assert from "node:assert/strict";
import test from "node:test";
import { completeVisit, isFileReviewComplete, nextReviewVisit, reconcileReviewMapState } from "../web/review-visit-state.js";

const map = {
  chapters: [{ id: "one", reviewOrder: 1, visits: [
    { id: "visit-contract", fileId: "src/runtime.py", changeUnitIds: ["unit-contract"] },
    { id: "visit-test", fileId: "tests/test_runtime.py", changeUnitIds: ["unit-test"] },
  ] }, { id: "two", reviewOrder: 2, visits: [
    { id: "visit-cleanup", fileId: "src/runtime.py", changeUnitIds: ["unit-cleanup"] },
  ] }],
};

test("visit navigation follows chapter order and file completion requires every visit", () => {
  assert.equal(nextReviewVisit(map, {}, null, 1)?.id, "visit-contract");
  assert.equal(nextReviewVisit(map, {}, "visit-contract", 1)?.id, "visit-test");
  const progress = completeVisit({}, "visit-contract");
  assert.equal(isFileReviewComplete(map, progress, "src/runtime.py"), false);
  assert.equal(isFileReviewComplete(map, completeVisit(progress, "visit-cleanup"), "src/runtime.py"), true);
});

test("map reconciliation preserves progress by exact unit identity and active file", () => {
  const nextMap = {
    chapters: [{ id: "semantic", reviewOrder: 1, visits: [
      { id: "semantic-contract", fileId: "src/runtime.py", changeUnitIds: ["unit-contract"] },
      { id: "semantic-cleanup", fileId: "src/runtime.py", changeUnitIds: ["unit-cleanup"] },
    ] }],
  };
  const reconciled = reconcileReviewMapState(map, nextMap, {
    reviewedVisits: { "visit-contract": true },
    activeVisitId: "visit-contract",
    activeFileId: "src/runtime.py",
  });
  assert.deepEqual(reconciled.reviewedVisits, { "semantic-contract": true });
  assert.equal(reconciled.activeVisitId, "semantic-contract");
  assert.equal(reconciled.activeFileId, "src/runtime.py");
});
