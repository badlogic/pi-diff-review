import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_MAP_SCOUT_PROMPT, runReviewMapScouts } from "../src/review-map-scout.js";
import type { RunReviewMapScoutsOptions } from "../src/review-map-scout.js";
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

function validFacts(unitIds: string[]): string {
  return JSON.stringify({ facts: [{
    unitIds,
    intent: "Trace the runtime change.",
    changedContracts: [],
    callersAndDependencies: [],
    removedBehavior: [],
    invariants: [],
    testEvidence: [],
    evidenceGaps: [],
    candidateRelationships: [],
    confidence: "medium",
    unresolvedQuestions: [],
  }] });
}

function baseOptions(
  units: ReviewChangeUnit[],
  cache = new Map<string, string>(),
): RunReviewMapScoutsOptions {
  return {
    sourceFingerprint: "sha256:retry",
    strategyVersion: "semantic-map-v2",
    units,
    getPatch: async () => "@@ patch",
    complete: async (input) => validFacts(
      (JSON.parse(input).units as Array<{ id: string }>).map((entry) => entry.id),
    ),
    cache,
    maxInputChars: 5_000,
    concurrency: 1,
  };
}

test("scout prompt bounds response verbosity before model completion", () => {
  assert.match(REVIEW_MAP_SCOUT_PROMPT, /no more facts than supplied units/i);
  assert.match(REVIEW_MAP_SCOUT_PROMPT, /at most 4 items/i);
  assert.match(REVIEW_MAP_SCOUT_PROMPT, /240 characters/i);
});

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
  assert.equal(result.diagnostics.length, 2);
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

test("scout requests load and include each file patch once", async () => {
  const units = [unit("left", "src/runtime.ts", ["c1"]), unit("right", "src/runtime.ts", ["c1"])];
  let patchLoads = 0;
  let request: { units: Array<{ id: string }>; files: Array<{ unitIds: string[] }> } | undefined;
  const result = await runReviewMapScouts({
    sourceFingerprint: "sha256:dedupe",
    strategyVersion: "semantic-map-v2",
    units,
    getPatch: async () => {
      patchLoads += 1;
      return "@@ patch";
    },
    complete: async (input) => {
      request = JSON.parse(input) as typeof request;
      return validFacts(request!.units.map((entry) => entry.id));
    },
    cache: new Map(),
    maxInputChars: 5_000,
    concurrency: 1,
  });

  assert.deepEqual(result.diagnostics, []);
  assert.equal(patchLoads, 1);
  assert.equal(request?.files.length, 1);
  assert.deepEqual(request?.files[0]?.unitIds, ["left", "right"]);
});

test("scout requests fit escape-heavy serialized JSON exactly", async () => {
  const units = Array.from({ length: 8 }, (_, index) => unit(`u${index}`, `src/f${index}.ts`, ["c1"]));
  const inputs: string[] = [];
  const result = await runReviewMapScouts({
    sourceFingerprint: "sha256:escaped",
    strategyVersion: "semantic-map-v2",
    units,
    getPatch: async () => `\\\"\nλ`.repeat(8_000),
    complete: async (input) => {
      inputs.push(input);
      const ids = (JSON.parse(input).units as Array<{ id: string }>).map((entry) => entry.id);
      return validFacts(ids);
    },
    cache: new Map(),
    maxInputChars: 45_000,
    concurrency: 1,
  });

  assert.deepEqual(result.diagnostics, []);
  assert.ok(inputs.every((input) => input.length <= 45_000));
});

test("scout requests split deterministically when combined fixed metadata cannot fit", async () => {
  const suffix = "x".repeat(800);
  const units = [unit("left", `src/a-${suffix}.ts`, ["c1"]), unit("right", `src/b-${suffix}.ts`, ["c1"])];
  const requests: string[][] = [];
  const result = await runReviewMapScouts({
    sourceFingerprint: "sha256:split",
    strategyVersion: "semantic-map-v2",
    units,
    getPatch: async () => "patch",
    complete: async (input) => {
      assert.ok(input.length <= 5_000);
      const ids = (JSON.parse(input).units as Array<{ id: string }>).map((entry) => entry.id);
      requests.push(ids);
      return validFacts(ids);
    },
    cache: new Map(),
    maxInputChars: 5_000,
    concurrency: 1,
  });

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(requests, [["left"], ["right"]]);
});

test("a malformed scout response is retried once and then cached", async () => {
  let calls = 0;
  const cache = new Map<string, string>();
  const result = await runReviewMapScouts({
    ...baseOptions([unit("one", "one.ts", ["c1"])], cache),
    complete: async (input) => {
      calls += 1;
      if (calls === 1) return "not-json";
      const ids = (JSON.parse(input).units as Array<{ id: string }>).map((entry) => entry.id);
      return validFacts(ids);
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.facts.length, 1);
  assert.equal(cache.size, 1);
  assert.match(result.diagnostics.join(" "), /attempt 1/i);
});

test("an invalid batch does not discard or repeat a successful batch", async () => {
  const cache = new Map<string, string>();
  const calls = new Map<string, number>();
  const options = baseOptions([
    unit("good", "good.ts", ["c1"]),
    unit("bad", "bad.ts", ["c2"]),
  ], cache);
  options.complete = async (input) => {
    const id = (JSON.parse(input).units as Array<{ id: string }>)[0]!.id;
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return id === "good" ? validFacts([id]) : validFacts(["invented"]);
  };

  const first = await runReviewMapScouts(options);
  const second = await runReviewMapScouts(options);

  assert.deepEqual(first.facts.map((fact) => fact.unitIds), [["good"]]);
  assert.deepEqual(second.facts.map((fact) => fact.unitIds), [["good"]]);
  assert.equal(calls.get("good"), 1);
  assert.equal(calls.get("bad"), 4);
});

test("scout facts and free text are bounded before planning", async () => {
  const verbose = "x".repeat(3_000);
  const relationships = Array.from({ length: 45 }, () => ({
    fromUnitId: "one",
    toUnitId: "one",
    reason: verbose,
  }));
  const response = JSON.stringify({
    facts: Array.from({ length: 45 }, () => ({
      unitIds: ["one"],
      intent: verbose,
      changedContracts: Array.from({ length: 45 }, () => verbose),
      callersAndDependencies: [],
      removedBehavior: [],
      invariants: [],
      testEvidence: [],
      evidenceGaps: [],
      candidateRelationships: relationships,
      confidence: "medium",
      unresolvedQuestions: [],
    })),
  });
  const result = await runReviewMapScouts({
    ...baseOptions([unit("one", "one.ts", ["c1"])]),
    complete: async () => response,
  });

  assert.equal(result.facts.length, 40);
  assert.equal(result.facts[0]!.intent.length, 2_000);
  assert.equal(result.facts[0]!.changedContracts.length, 40);
  assert.equal(result.facts[0]!.changedContracts[0]!.length, 2_000);
  assert.equal(result.facts[0]!.candidateRelationships.length, 40);
  assert.equal(result.facts[0]!.candidateRelationships[0]!.reason.length, 2_000);
  assert.match(result.diagnostics.join(" "), /truncated/i);
});

test("concurrent scout results retain deterministic batch order", async () => {
  const result = await runReviewMapScouts({
    ...baseOptions([
      unit("first", "a.ts", ["c1"]),
      unit("second", "b.ts", ["c2"]),
    ]),
    concurrency: 2,
    complete: async (input) => {
      const ids = (JSON.parse(input).units as Array<{ id: string }>).map((entry) => entry.id);
      if (ids.includes("first")) await new Promise((resolve) => setTimeout(resolve, 20));
      return validFacts(ids);
    },
  });

  assert.deepEqual(result.facts.map((fact) => fact.unitIds), [["first"], ["second"]]);
});

test("a patch-load failure skips only its batch", async () => {
  const completed: string[][] = [];
  const result = await runReviewMapScouts({
    ...baseOptions([
      unit("bad", "a.ts", ["c1"]),
      unit("good", "b.ts", ["c2"]),
    ]),
    concurrency: 2,
    getPatch: async (item) => {
      if (item.id === "bad") throw new Error("patch unavailable");
      return "patch";
    },
    complete: async (input) => {
      const ids = (JSON.parse(input).units as Array<{ id: string }>).map((entry) => entry.id);
      completed.push(ids);
      return validFacts(ids);
    },
  });

  assert.deepEqual(completed, [["good"]]);
  assert.deepEqual(result.facts.map((fact) => fact.unitIds), [["good"]]);
  assert.match(result.diagnostics.join(" "), /map\.scout batch 1.*patch unavailable/i);
});

test("patch loading obeys configured concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const units = Array.from({ length: 6 }, (_, index) => unit(`u${index}`, `${index}.ts`, [`c${index}`]));
  const result = await runReviewMapScouts({
    ...baseOptions(units),
    concurrency: 2,
    getPatch: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return "patch";
    },
  });

  assert.deepEqual(result.diagnostics, []);
  assert.ok(maximum <= 2);
});
