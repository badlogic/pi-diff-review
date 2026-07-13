import assert from "node:assert/strict";
import test from "node:test";
import { isReviewMap } from "../src/session-store.js";
import type { ReviewMap } from "../src/types.js";

function mapFixture(): ReviewMap {
  return {
    version: 2,
    status: "semantic",
    sourceFingerprint: "sha256:fixture",
    strategyVersion: "semantic-map-v1",
    story: {
      intent: "Move tool execution behind an async runtime.",
      behaviorBefore: "Callers owned synchronous tool lifecycles.",
      behaviorAfter: "The session runtime owns async execution and cleanup.",
      primaryFlows: ["contract -> runtime -> verification"],
      removedOrReplacedBehavior: ["continuation-token dispatch"],
    },
    changeUnits: [{
      id: "unit-contract",
      fileId: "src/runtime.ts",
      path: "src/runtime.ts",
      ranges: [{ fileId: "src/runtime.ts", path: "src/runtime.ts", side: "modified", startLine: 10, endLine: 12 }],
      status: "modified",
      commitIds: ["commit-1"],
    }, {
      id: "unit-cleanup",
      fileId: "src/runtime.ts",
      path: "src/runtime.ts",
      ranges: [{ fileId: "src/runtime.ts", path: "src/runtime.ts", side: "modified", startLine: 30, endLine: 32 }],
      status: "modified",
      commitIds: ["commit-2"],
    }],
    chapters: [{
      id: "contracts",
      title: "Async contract",
      objective: "Establish the new execution boundary.",
      whyItMatters: "Every caller depends on this lifecycle contract.",
      summary: "Review the async contract before its callers.",
      reviewOrder: 1,
      reviewWeight: 3,
      priority: "review-first",
      priorityReason: "The runtime depends on this public contract.",
      attentionTags: ["Contracts"],
      dependsOn: [],
      reviewQuestions: ["Does the contract define ownership and cancellation?"],
      changeFlow: ["contract", "runtime"],
      visits: [{
        id: "visit-contract",
        fileId: "src/runtime.ts",
        changeUnitIds: ["unit-contract"],
        role: "contract",
        reason: "Read the public boundary first.",
        focus: ["ownership"],
      }],
      testEvidence: [],
      exitCriteria: ["Ownership is explicit."],
      fileIds: ["src/runtime.ts"],
      ranges: [{ fileId: "src/runtime.ts", path: "src/runtime.ts", side: "modified", startLine: 10, endLine: 12 }],
      findingIds: [],
    }, {
      id: "cleanup",
      title: "Runtime cleanup",
      objective: "Verify session cleanup.",
      whyItMatters: "Leaked resources outlive the request.",
      summary: "Review cleanup after the contract.",
      reviewOrder: 2,
      reviewWeight: 3,
      priority: "standard",
      priorityReason: "It implements the contract lifecycle.",
      attentionTags: ["Lifecycle"],
      dependsOn: ["contracts"],
      reviewQuestions: ["Are resources released on cancellation?"],
      changeFlow: ["runtime", "cleanup"],
      visits: [{
        id: "visit-cleanup",
        fileId: "src/runtime.ts",
        changeUnitIds: ["unit-cleanup"],
        role: "implementation",
        reason: "Inspect cleanup separately from the public contract.",
        focus: ["cancellation"],
      }],
      testEvidence: [],
      exitCriteria: ["All terminal paths release resources."],
      fileIds: ["src/runtime.ts"],
      ranges: [{ fileId: "src/runtime.ts", path: "src/runtime.ts", side: "modified", startLine: 30, endLine: 32 }],
      findingIds: [],
    }],
    coverage: {
      fileCount: 1,
      originalLineCount: 0,
      modifiedLineCount: 6,
      unmappedFileCount: 0,
      unmappedOriginalLineCount: 0,
      unmappedModifiedLineCount: 0,
      overlappingOriginalLineCount: 0,
      overlappingModifiedLineCount: 0,
    },
    diagnostics: [],
  };
}

test("review map v2 accepts disjoint visits to the same file", () => {
  assert.equal(isReviewMap(mapFixture()), true);
});

test("review map v2 rejects dangling visit unit references", () => {
  const map = mapFixture();
  map.chapters[1]!.visits[0]!.changeUnitIds = ["unit-invented"];
  assert.equal(isReviewMap(map), false);
});

test("review map v2 rejects unsupported versions and duplicate visit ids", () => {
  const unsupported = { ...mapFixture(), version: 3 };
  assert.equal(isReviewMap(unsupported), false);

  const duplicated = mapFixture();
  duplicated.chapters[1]!.visits[0]!.id = "visit-contract";
  assert.equal(isReviewMap(duplicated), false);
});

test("review map v2 rejects duplicate semantic ownership across visits", () => {
  const map = mapFixture();
  map.chapters[1]!.visits[0]!.changeUnitIds = ["unit-contract"];
  map.chapters[1]!.visits[0]!.fileId = "src/runtime.ts";
  assert.equal(isReviewMap(map), false);
});
