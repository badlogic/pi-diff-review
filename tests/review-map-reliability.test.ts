import assert from "node:assert/strict";
import test from "node:test";
import { runReviewMapScouts } from "../src/review-map-scout.js";
import type { ReviewChangeUnit } from "../src/types.js";

function syntheticUnit(input: {
  id: string;
  path: string;
  commitIds: string[];
  startLine: number;
}): ReviewChangeUnit {
  return {
    id: input.id,
    fileId: input.path,
    path: input.path,
    status: "modified",
    commitIds: input.commitIds,
    ranges: [{
      fileId: input.path,
      path: input.path,
      side: "modified",
      startLine: input.startLine,
      endLine: input.startLine + 2,
    }],
  };
}

function validFacts(unitIds: string[]): string {
  return JSON.stringify({ facts: [{
    unitIds,
    intent: "Trace the synthetic runtime change.",
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

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("seeded large-map scout requests never exceed their serialized budget", async () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    const next = random(seed);
    const units = Array.from({ length: 18 }, (_, index) => syntheticUnit({
      id: `s${seed}-u${index}`,
      path: `src/group-${Math.floor(index / 6)}/file-${Math.floor(index / 2) % 3}.ts`,
      commitIds: [`c${Math.floor(index / 6)}`, ...(index % 7 === 0 ? ["bridge"] : [])],
      startLine: 1 + Math.floor(next() * 2_000),
    }));
    const inputs: string[] = [];
    const loadedFileIds = new Set<string>();
    const result = await runReviewMapScouts({
      sourceFingerprint: `sha256:${seed}`,
      strategyVersion: "semantic-map-v2",
      units,
      getPatch: async (unit) => {
        assert.equal(loadedFileIds.has(unit.fileId), false);
        loadedFileIds.add(unit.fileId);
        return `line \\ \" λ\n`.repeat(500 + Math.floor(next() * 2_000));
      },
      complete: async (input) => {
        inputs.push(input);
        return validFacts((JSON.parse(input).units as Array<{ id: string }>).map((entry) => entry.id));
      },
      cache: new Map(),
      maxInputChars: 5_000,
      concurrency: 3,
    });

    assert.equal(result.diagnostics.some((entry) => /exceeds the configured input budget/i.test(entry)), false);
    assert.ok(inputs.every((input) => input.length <= 5_000));
    assert.equal(loadedFileIds.size, new Set(units.map((unit) => unit.fileId)).size);
    for (const input of inputs) {
      const files = JSON.parse(input).files as Array<{ fileId: string }>;
      assert.equal(new Set(files.map((file) => file.fileId)).size, files.length);
    }
  }
});
