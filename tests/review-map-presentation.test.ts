import assert from "node:assert/strict";
import test from "node:test";
import {
  completeReviewMapPresentation,
  reviewMapNeedsPresentationGate,
} from "../src/review-map-presentation.js";
import type { ReviewMap } from "../src/types.js";

function map(status: ReviewMap["status"]): ReviewMap {
  return {
    version: 2,
    status,
    sourceFingerprint: "sha256:test",
    strategyVersion: status === "provisional" ? "provisional-map-v1" : "semantic-map-v1",
    story: {
      intent: "Test",
      behaviorBefore: "",
      behaviorAfter: "",
      primaryFlows: [],
      removedOrReplacedBehavior: [],
    },
    changeUnits: [],
    chapters: [],
    coverage: {
      fileCount: 0,
      originalLineCount: 0,
      modifiedLineCount: 0,
      unmappedFileCount: 0,
      unmappedOriginalLineCount: 0,
      unmappedModifiedLineCount: 0,
      overlappingOriginalLineCount: 0,
      overlappingModifiedLineCount: 0,
    },
    diagnostics: [],
  };
}

test("only cached semantic maps bypass the presentation gate", () => {
  assert.equal(reviewMapNeedsPresentationGate(map("semantic")), false);
  assert.equal(reviewMapNeedsPresentationGate(map("semantic-repaired")), false);
  for (const status of ["provisional", "mapping", "fallback"] as const) {
    assert.equal(reviewMapNeedsPresentationGate(map(status)), true);
  }
});

test("persists and delivers a completed map before releasing presentation", async () => {
  const calls: string[] = [];
  const result = await completeReviewMapPresentation({
    map: map("semantic"),
    canPresent: () => true,
    apply: () => calls.push("apply"),
    persist: async () => { calls.push("persist"); return true; },
    updateProtocol: () => calls.push("protocol"),
    deliver: () => { calls.push("deliver"); return true; },
    release: () => calls.push("release"),
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ["apply", "persist", "protocol", "deliver", "release"]);
});

test("does not deliver or release when persistence fails", async () => {
  const calls: string[] = [];
  const result = await completeReviewMapPresentation({
    map: map("fallback"),
    canPresent: () => true,
    apply: () => calls.push("apply"),
    persist: async () => { calls.push("persist"); return false; },
    updateProtocol: () => calls.push("protocol"),
    deliver: () => { calls.push("deliver"); return true; },
    release: () => calls.push("release"),
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ["apply", "persist"]);
});

test("does not release when renderer delivery fails", async () => {
  const calls: string[] = [];
  const result = await completeReviewMapPresentation({
    map: map("semantic"),
    canPresent: () => true,
    apply: () => calls.push("apply"),
    persist: async () => { calls.push("persist"); return true; },
    updateProtocol: () => calls.push("protocol"),
    deliver: () => { calls.push("deliver"); return false; },
    release: () => calls.push("release"),
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ["apply", "persist", "protocol", "deliver"]);
});
