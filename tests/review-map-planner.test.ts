import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewMapPlan } from "../src/review-map-planner.js";
import type { ReviewChangeUnit } from "../src/types.js";

function unit(id: string, path: string): ReviewChangeUnit {
  return { id, fileId: path, path, status: "modified", commitIds: [], ranges: [{ fileId: path, path, side: "modified", startLine: 1, endLine: 2 }] };
}

function validPlan() {
  return {
    story: {
      intent: "Move tools to an async session runtime.",
      behaviorBefore: "Callers owned synchronous execution.",
      behaviorAfter: "The session owns async execution and cleanup.",
      primaryFlows: ["contract -> runtime -> verification"],
      removedOrReplacedBehavior: ["continuation token routing"],
    },
    chapters: [{
      id: "async-runtime",
      title: "Async tool contract and runtime ownership",
      objective: "Verify the new async boundary and ownership model.",
      whyItMatters: "All callers depend on cancellation and cleanup semantics.",
      priority: "review-first",
      priorityReason: "The contract defines every downstream call.",
      dependsOn: [],
      reviewQuestions: ["Who owns cancellation and cleanup?"],
      changeFlow: ["contract", "runtime", "verification"],
      visits: [{ id: "contract-visit", fileId: "src/contracts.py", changeUnitIds: ["contract"], role: "contract", reason: "Read the boundary first.", focus: ["lifecycle"] },
        { id: "runtime-visit", fileId: "src/runtime.py", changeUnitIds: ["runtime"], role: "implementation", reason: "Trace ownership implementation.", focus: ["cleanup"] }],
      testEvidence: [],
      exitCriteria: ["Ownership is explicit on all terminal paths."],
    }],
  };
}

const units = [unit("contract", "src/contracts.py"), unit("runtime", "src/runtime.py")];

test("planner accepts a complete behavioral journey", () => {
  const plan = parseReviewMapPlan(JSON.stringify(validPlan()), units);
  assert.equal(plan.chapters[0]?.visits.length, 2);
  assert.equal(plan.story.behaviorAfter, "The session owns async execution and cleanup.");
});

test("planner rejects directory buckets, duplicate ownership, and invented units", () => {
  const generic = validPlan();
  generic.chapters[0]!.title = "Miscellaneous changes";
  assert.throws(() => parseReviewMapPlan(JSON.stringify(generic), units), /generic|directory|miscellaneous/i);

  const duplicate = validPlan();
  duplicate.chapters[0]!.visits.push({ ...duplicate.chapters[0]!.visits[0]!, id: "duplicate" });
  assert.throws(() => parseReviewMapPlan(JSON.stringify(duplicate), units), /more than once|duplicate/i);

  const invented = validPlan();
  invented.chapters[0]!.visits[0]!.changeUnitIds = ["invented"];
  assert.throws(() => parseReviewMapPlan(JSON.stringify(invented), units), /unknown|invented/i);
});

test("planner rejects chapters without actionable reviewer guidance", () => {
  const plan = validPlan();
  plan.chapters[0]!.reviewQuestions = [];
  assert.throws(() => parseReviewMapPlan(JSON.stringify(plan), units), /review question/i);
});
