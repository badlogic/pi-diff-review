import assert from "node:assert/strict";
import test from "node:test";
import { runReviewMapScouts } from "../src/review-map-scout.js";
import type { ReviewChangeUnit } from "../src/types.js";

function unit(id: string, path: string, commits: string[]): ReviewChangeUnit {
  return {
    id,
    fileId: path,
    path,
    status: "modified",
    commitIds: commits,
    ranges: [{ fileId: path, path, side: "modified", startLine: 1, endLine: 2 }],
  };
}

test("semantic scouts validate facts and reuse cached groups", async () => {
  const units = [unit("contract", "src/contracts.py", ["c1"]), unit("runtime", "src/runtime.py", ["c1"])];
  let calls = 0;
  const complete = async (input: string) => {
    calls += 1;
    const parsed = JSON.parse(input);
    assert.ok(input.length < 4_000);
    return JSON.stringify({
      facts: [{
        unitIds: parsed.units.map((item: any) => item.id),
        intent: "Move execution into the async runtime.",
        changedContracts: ["Tool execution is awaitable."],
        callersAndDependencies: ["Session runtime consumes the contract."],
        removedBehavior: [],
        invariants: ["Cancellation releases owned resources."],
        testEvidence: [],
        evidenceGaps: ["No cancellation test is present."],
        candidateRelationships: [{ fromUnitId: "contract", toUnitId: "runtime", reason: "contract is implemented by runtime" }],
        confidence: "high",
        unresolvedQuestions: [],
      }],
    });
  };
  const cache = new Map<string, string>();
  const options = {
    sourceFingerprint: "sha256:a",
    strategyVersion: "semantic-map-v1",
    units,
    getPatch: async (item: ReviewChangeUnit) => `patch:${item.id}`,
    complete,
    cache,
    maxInputChars: 4_000,
    concurrency: 2,
  };

  const first = await runReviewMapScouts(options);
  const second = await runReviewMapScouts(options);

  assert.equal(first.facts.length, 1);
  assert.deepEqual(first.diagnostics, []);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("semantic scouts reject invented unit references without failing other groups", async () => {
  const units = [unit("contract", "src/contracts.py", ["c1"]), unit("other", "docs/readme.md", ["c2"])];
  const result = await runReviewMapScouts({
    sourceFingerprint: "sha256:a",
    strategyVersion: "semantic-map-v1",
    units,
    getPatch: async () => "patch",
    complete: async (input) => {
      const ids = (JSON.parse(input).units as Array<{ id: string }>).map((item) => item.id);
      return JSON.stringify({ facts: [{
        unitIds: ids.includes("other") ? ["invented"] : ids,
        intent: "intent", changedContracts: [], callersAndDependencies: [], removedBehavior: [], invariants: [],
        testEvidence: [], evidenceGaps: [], candidateRelationships: [], confidence: "medium", unresolvedQuestions: [],
      }] });
    },
    cache: new Map(),
    maxInputChars: 4_000,
    concurrency: 2,
  });

  assert.equal(result.facts.length, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0]!, /invented|unknown/i);
});

test("semantic scout grouping closes transitive commit relationships", async () => {
  const units = [
    unit("left", "a.py", ["c1"]),
    unit("right", "b.py", ["c2"]),
    unit("bridge", "z.py", ["c1", "c2"]),
  ];
  const groups: string[][] = [];
  await runReviewMapScouts({
    sourceFingerprint: "sha256:a", strategyVersion: "semantic-map-v1", units,
    getPatch: async () => "patch", cache: new Map(), maxInputChars: 4_000, concurrency: 1,
    complete: async (input) => {
      const ids = (JSON.parse(input).units as Array<{ id: string }>).map((item) => item.id);
      groups.push(ids);
      return JSON.stringify({ facts: [{ unitIds: ids, intent: "intent", changedContracts: [], callersAndDependencies: [], removedBehavior: [], invariants: [], testEvidence: [], evidenceGaps: [], candidateRelationships: [], confidence: "medium", unresolvedQuestions: [] }] });
    },
  });
  assert.deepEqual(groups, [["left", "bridge", "right"]]);
});
