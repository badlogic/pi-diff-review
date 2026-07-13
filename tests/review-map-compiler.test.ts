import assert from "node:assert/strict";
import test from "node:test";
import { compileReviewMap, ReviewMapQualityError } from "../src/review-map-compiler.js";
import type { ReviewMapPlan } from "../src/review-map-planner.js";
import type { ReviewChangeUnit } from "../src/types.js";

function unit(id: string, fileId: string, start: number, end: number): ReviewChangeUnit {
  return { id, fileId, path: fileId, status: "modified", commitIds: [], ranges: [{ fileId, path: fileId, side: "modified", startLine: start, endLine: end }] };
}

function plan(unitIds = ["one", "two"]): ReviewMapPlan {
  return {
    story: { intent: "intent", behaviorBefore: "before", behaviorAfter: "after", primaryFlows: ["flow"], removedOrReplacedBehavior: [] },
    chapters: [{
      id: "behavior", title: "Runtime behavior", objective: "Review runtime behavior.", whyItMatters: "It owns execution.",
      priority: "review-first", priorityReason: "Read first.", dependsOn: [], reviewQuestions: ["Is ownership correct?"],
      changeFlow: ["contract", "implementation"],
      visits: unitIds.map((id, index) => ({ id: `visit-${id}`, fileId: "src/runtime.py", changeUnitIds: [id], role: index === 0 ? "contract" : "implementation", reason: "Follow behavior.", focus: [] })),
      testEvidence: [], exitCriteria: ["Behavior is understood."],
    }],
  };
}

test("compiler derives exact coverage and supports split-file visits", () => {
  const units = [unit("one", "src/runtime.py", 1, 2), unit("two", "src/runtime.py", 10, 12)];
  const map = compileReviewMap({ sourceFingerprint: "sha256:a", strategyVersion: "semantic-map-v1", plan: plan(), units, status: "semantic" });
  assert.equal(map.coverage.modifiedLineCount, 5);
  assert.equal(map.coverage.unmappedModifiedLineCount, 0);
  assert.equal(map.coverage.overlappingModifiedLineCount, 0);
  assert.equal(map.chapters[0]?.fileIds.length, 1);
  assert.equal(map.chapters[0]?.visits.length, 2);
});

test("compiler rejects overlapping canonical units and dependency cycles", () => {
  assert.throws(() => compileReviewMap({
    sourceFingerprint: "sha256:a", strategyVersion: "semantic-map-v1", plan: plan(),
    units: [unit("one", "src/runtime.py", 1, 3), unit("two", "src/runtime.py", 3, 4)], status: "semantic",
  }), /overlap/i);

  const cyclic = plan(["one"]);
  cyclic.chapters.push({ ...cyclic.chapters[0]!, id: "caller", title: "Caller integration", dependsOn: ["behavior"], visits: [{ ...cyclic.chapters[0]!.visits[0]!, id: "visit-two", changeUnitIds: ["two"] }] });
  cyclic.chapters[0]!.dependsOn = ["caller"];
  assert.throws(() => compileReviewMap({
    sourceFingerprint: "sha256:a", strategyVersion: "semantic-map-v1", plan: cyclic,
    units: [unit("one", "src/runtime.py", 1, 2), unit("two", "src/runtime.py", 10, 12)], status: "semantic",
  }), /cycle/i);
});

test("compiler requests repair when supporting changes exceed quality thresholds", () => {
  const units = [unit("one", "src/runtime.py", 1, 2), unit("two", "src/runtime.py", 10, 40)];
  assert.throws(() => compileReviewMap({
    sourceFingerprint: "sha256:a", strategyVersion: "semantic-map-v1", plan: plan(["one"]), units, status: "semantic",
  }), (error) => error instanceof ReviewMapQualityError && /supporting/i.test(error.message));
});
