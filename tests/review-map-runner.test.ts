import assert from "node:assert/strict";
import test from "node:test";
import { createFallbackReviewMap, runSemanticReviewMap } from "../src/review-map-runner.js";
import type { RunSemanticReviewMapOptions } from "../src/review-map-runner.js";
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

function invalidPriorityPlan(unitIds: string[]): string {
  const value = JSON.parse(plan(unitIds)) as { chapters: Array<{ priority: string }> };
  value.chapters[0]!.priority = "critical";
  return JSON.stringify(value);
}

function runnerOptions(): RunSemanticReviewMapOptions {
  const units = [unit("one", 1, 2), unit("two", 10, 12)];
  return {
    sourceFingerprint: "sha256:a",
    strategyVersion: "semantic-map-v2",
    units,
    provisionalMap: compileProvisionalReviewMap({ sourceFingerprint: "sha256:a", units, commits: [] }),
    runScouts: async () => ({ facts: [], diagnostics: [] }),
    plan: async () => plan(["one", "two"]),
    criticize: async () => JSON.stringify({ action: "accept", diagnostics: [] }),
    onProgress: () => {},
  };
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

test("fallback conversion preserves the deterministic map and appends diagnostics", () => {
  const units = [unit("one", 1, 2)];
  const provisional = compileProvisionalReviewMap({ sourceFingerprint: "sha256:a", units, commits: [] });
  const fallback = createFallbackReviewMap(provisional, ["planner unavailable"]);

  assert.equal(fallback.status, "fallback");
  assert.deepEqual(fallback.chapters, provisional.chapters);
  assert.deepEqual(fallback.diagnostics, [...provisional.diagnostics, "planner unavailable"]);
});

test("invalid planner priority is repaired before fallback", async () => {
  let calls = 0;
  const result = await runSemanticReviewMap({
    ...runnerOptions(),
    plan: async () => {
      calls += 1;
      return calls === 1 ? invalidPriorityPlan(["one", "two"]) : plan(["one", "two"]);
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.status, "semantic-repaired");
  assert.match(result.diagnostics.join(" "), /map\.planner contract repair 1\/2/i);
});

test("planner contract repair stops after two additional calls", async () => {
  let calls = 0;
  const result = await runSemanticReviewMap({
    ...runnerOptions(),
    plan: async () => {
      calls += 1;
      return invalidPriorityPlan(["one", "two"]);
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.status, "fallback");
  assert.match(result.diagnostics.join(" "), /repair budget exhausted|invalid priority/i);
});

test("planner contract and compiler quality consume one shared repair budget", async () => {
  const units = [unit("one", 1, 2), unit("two", 10, 40)];
  let calls = 0;
  const result = await runSemanticReviewMap({
    ...runnerOptions(),
    units,
    provisionalMap: compileProvisionalReviewMap({ sourceFingerprint: "sha256:a", units, commits: [] }),
    plan: async () => {
      calls += 1;
      if (calls === 1) return invalidPriorityPlan(["one", "two"]);
      if (calls === 2) return plan(["one"]);
      return plan(["one", "two"]);
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.status, "semantic-repaired");
  assert.match(result.diagnostics.join(" "), /map\.planner contract repair 1\/2/i);
  assert.match(result.diagnostics.join(" "), /map\.compiler quality repair 2\/2/i);
});

test("critic repair and contract repair share the same planner budget", async () => {
  let calls = 0;
  const result = await runSemanticReviewMap({
    ...runnerOptions(),
    plan: async () => {
      calls += 1;
      return calls === 2 ? invalidPriorityPlan(["one", "two"]) : plan(["one", "two"]);
    },
    criticize: async () => JSON.stringify({
      action: "repair",
      diagnostics: ["Clarify the runtime flow."],
      instructions: "Clarify the runtime flow.",
    }),
  });

  assert.equal(calls, 3);
  assert.equal(result.status, "semantic-repaired");
  assert.match(result.diagnostics.join(" "), /map\.critic repair 1\/2/i);
  assert.match(result.diagnostics.join(" "), /map\.planner contract repair 2\/2/i);
});

test("a malformed critic response degrades to deterministic compilation", async () => {
  const result = await runSemanticReviewMap({
    ...runnerOptions(),
    criticize: async () => "not-json",
  });

  assert.equal(result.status, "semantic");
  assert.match(result.diagnostics.join(" "), /map\.critic/i);
});

test("critic diagnostics are count-bounded, flattened, and length-bounded", async () => {
  const result = await runSemanticReviewMap({
    ...runnerOptions(),
    criticize: async () => JSON.stringify({
      action: "accept",
      diagnostics: Array.from({ length: 60 }, () => `critic\n${"x".repeat(2_000)}`),
    }),
  });

  assert.equal(result.status, "semantic");
  assert.equal(result.diagnostics.length, 40);
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.length <= 500));
  assert.ok(result.diagnostics.every((diagnostic) => !diagnostic.includes("\n")));
});

test("deterministic compiler invariants do not trigger planner repair", async () => {
  const units = [unit("one", 1, 3), unit("two", 3, 4)];
  let calls = 0;
  const result = await runSemanticReviewMap({
    ...runnerOptions(),
    units,
    provisionalMap: compileProvisionalReviewMap({ sourceFingerprint: "sha256:a", units, commits: [] }),
    plan: async () => {
      calls += 1;
      return plan(["one", "two"]);
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.status, "fallback");
  assert.match(result.diagnostics.join(" "), /overlap/i);
});
