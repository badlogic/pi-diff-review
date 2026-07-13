import assert from "node:assert/strict";
import test from "node:test";
import { runSemanticReviewMap } from "../src/review-map-runner.js";
import { compileProvisionalReviewMap } from "../src/provisional-review-map.js";
import type { ReviewChangeUnit } from "../src/types.js";

function unit(id: string, start: number, end: number): ReviewChangeUnit {
  return { id, fileId: "src/runtime.py", path: "src/runtime.py", status: "modified", commitIds: ["c1"], ranges: [{ fileId: "src/runtime.py", path: "src/runtime.py", side: "modified", startLine: start, endLine: end }] };
}

function plan(unitIds: string[]) {
  return JSON.stringify({
    story: { intent: "Async runtime", behaviorBefore: "Sync callers", behaviorAfter: "Session-owned async runtime", primaryFlows: ["contract -> runtime"], removedOrReplacedBehavior: [] },
    chapters: [{ id: "runtime", title: "Async runtime ownership", objective: "Review runtime ownership.", whyItMatters: "It controls cleanup.", priority: "review-first", priorityReason: "Defines the flow.", dependsOn: [], reviewQuestions: ["Is cleanup complete?"], changeFlow: ["runtime"], visits: unitIds.map((id) => ({ id: `visit-${id}`, fileId: "src/runtime.py", changeUnitIds: [id], role: "implementation", reason: "Review runtime.", focus: [] })), testEvidence: [], exitCriteria: ["Cleanup is correct."] }],
  });
}

test("semantic runner streams progress and publishes only a compiled map", async () => {
  const units = [unit("one", 1, 2), unit("two", 10, 12)];
  const provisionalMap = compileProvisionalReviewMap({ sourceFingerprint: "sha256:a", units, commits: [] });
  const phases: string[] = [];
  const result = await runSemanticReviewMap({
    sourceFingerprint: "sha256:a", strategyVersion: "semantic-map-v1", units, provisionalMap,
    runScouts: async () => ({ facts: [], diagnostics: [] }),
    plan: async () => plan(["one", "two"]),
    criticize: async () => JSON.stringify({ action: "accept", diagnostics: [] }),
    onProgress: (progress) => phases.push(progress.phase),
  });
  assert.equal(result.status, "semantic");
  assert.deepEqual(phases, ["scout", "planner", "critic", "compile", "done"]);
  assert.equal(result.coverage.unmappedModifiedLineCount, 0);
});

test("semantic runner performs one repair and falls back truthfully when repair fails", async () => {
  const units = [unit("one", 1, 2), unit("two", 10, 40)];
  const provisionalMap = compileProvisionalReviewMap({ sourceFingerprint: "sha256:a", units, commits: [] });
  let plannerCalls = 0;
  const repaired = await runSemanticReviewMap({
    sourceFingerprint: "sha256:a", strategyVersion: "semantic-map-v1", units, provisionalMap,
    runScouts: async () => ({ facts: [], diagnostics: [] }),
    plan: async (_facts, repair) => {
      plannerCalls += 1;
      return repair ? plan(["one", "two"]) : plan(["one"]);
    },
    criticize: async () => JSON.stringify({ action: "accept", diagnostics: [] }),
    onProgress: () => {},
  });
  assert.equal(repaired.status, "semantic-repaired");
  assert.equal(plannerCalls, 2);

  const fallback = await runSemanticReviewMap({
    sourceFingerprint: "sha256:a", strategyVersion: "semantic-map-v1", units, provisionalMap,
    runScouts: async () => ({ facts: [], diagnostics: [] }),
    plan: async () => plan(["one"]),
    criticize: async () => JSON.stringify({ action: "accept", diagnostics: [] }),
    onProgress: () => {},
  });
  assert.equal(fallback.status, "fallback");
  assert.match(fallback.diagnostics.join(" "), /supporting/i);
});
