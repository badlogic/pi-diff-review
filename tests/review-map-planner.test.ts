import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewMapPlannerInput,
  parseReviewMapPlan,
  REVIEW_MAP_PLANNER_PROMPT,
  REVIEW_MAP_PRIORITIES,
  REVIEW_MAP_VISIT_ROLES,
} from "../src/review-map-planner.js";
import type { ReviewMapScoutFact } from "../src/review-map-scout.js";
import type { ReviewDataset } from "../src/sources/types.js";
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

function dataset(overrides: {
  repoRoot?: string;
  workingRoot?: string;
  pullRequestBody?: string;
  commitSubject?: string;
} = {}): ReviewDataset {
  return {
    repoRoot: overrides.repoRoot ?? "/repo",
    workingRoot: overrides.workingRoot ?? "/repo",
    files: [],
    analysisFileIds: [],
    commits: [{ sha: "abc123", shortSha: "abc123", subject: overrides.commitSubject ?? "Change runtime" }],
    source: {
      kind: "github-pr",
      label: "headout/magellan#669",
      repoRoot: overrides.repoRoot ?? "/repo",
      workingRoot: overrides.workingRoot ?? "/repo",
      baseRevision: "base",
      headRevision: "head",
      canPublishGitHubReview: true,
      github: {
        owner: "headout",
        repo: "magellan",
        number: 669,
        url: "https://github.com/headout/magellan/pull/669",
        title: "Align image scan telemetry",
        body: overrides.pullRequestBody ?? "Align emitted telemetry.",
        author: "author",
        baseRefName: "main",
        headRefName: "fix/telemetry",
        headRepositoryOwner: "headout",
        isDraft: false,
        state: "OPEN",
      },
    },
  };
}

const units = [unit("contract", "src/contracts.py"), unit("runtime", "src/runtime.py")];
const verboseFacts: ReviewMapScoutFact[] = [{
  unitIds: ["contract", "runtime"],
  intent: "intent ".repeat(1_000),
  changedContracts: ["contract ".repeat(1_000)],
  callersAndDependencies: ["caller ".repeat(1_000)],
  removedBehavior: [],
  invariants: ["invariant ".repeat(1_000)],
  testEvidence: [],
  evidenceGaps: ["gap ".repeat(1_000)],
  candidateRelationships: [{ fromUnitId: "contract", toUnitId: "runtime", reason: "reason ".repeat(1_000) }],
  confidence: "high",
  unresolvedQuestions: ["question ".repeat(1_000)],
}];

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

test("planner prompt enumerates every parser priority and visit role", () => {
  for (const priority of REVIEW_MAP_PRIORITIES) assert.match(REVIEW_MAP_PLANNER_PROMPT, new RegExp(priority));
  for (const role of REVIEW_MAP_VISIT_ROLES) assert.match(REVIEW_MAP_PLANNER_PROMPT, new RegExp(role));
});

test("planner prompt defines the nested JSON field types required by the parser", () => {
  assert.match(REVIEW_MAP_PLANNER_PROMPT, /story.*intent.*behaviorBefore.*behaviorAfter.*primaryFlows.*removedOrReplacedBehavior/is);
  assert.match(REVIEW_MAP_PLANNER_PROMPT, /changeUnitIds.*non-empty array of strings/is);
  assert.match(REVIEW_MAP_PLANNER_PROMPT, /focus.*array of strings/is);
  assert.match(REVIEW_MAP_PLANNER_PROMPT, /dependsOn.*reviewQuestions.*changeFlow.*exitCriteria.*arrays of strings/is);
  assert.match(REVIEW_MAP_PLANNER_PROMPT, /testEvidence.*visitIds.*proves.*doesNotProve.*arrays of strings/is);
});

test("planner prompt bounds descriptive output without limiting exact unit ownership", () => {
  assert.match(REVIEW_MAP_PLANNER_PROMPT, /each descriptive string.*240 characters/i);
  assert.match(REVIEW_MAP_PLANNER_PROMPT, /each descriptive array.*at most 5 items/i);
  assert.match(REVIEW_MAP_PLANNER_PROMPT, /combine units from the same file/i);
});

test("planner input remains bounded without omitting unit identity", () => {
  const largeDataset = dataset({
    repoRoot: "/private/repository/path",
    workingRoot: "/private/working/path",
    pullRequestBody: `body \\ \" λ\n`.repeat(4_000),
    commitSubject: "subject ".repeat(2_000),
  });
  const input = buildReviewMapPlannerInput(largeDataset, units, verboseFacts, {
    maxInputChars: 5_000,
  });
  const parsed = JSON.parse(input) as {
    units: Array<{ id: string }>;
    truncation: { omittedTextCharacters: number };
  };

  assert.ok(input.length <= 4_500);
  assert.deepEqual(parsed.units.map((entry) => entry.id), units.map((entry) => entry.id));
  assert.equal(input.includes("/private/repository/path"), false);
  assert.equal(input.includes("/private/working/path"), false);
  assert.ok(parsed.truncation.omittedTextCharacters > 0);
});

test("planner repair input fits the full limit and caps repair instructions", () => {
  const input = buildReviewMapPlannerInput(dataset(), units, verboseFacts, {
    maxInputChars: 5_000,
    repairInstructions: "repair ".repeat(2_000),
  });
  const parsed = JSON.parse(input) as { repairInstructions: string };

  assert.ok(input.length <= 5_000);
  assert.ok(parsed.repairInstructions.length <= 500);
});

test("planner repair reserve is measured after instruction JSON serialization", () => {
  const path = `src/${"x".repeat(1_700)}.ts`;
  const largeUnit = [unit("large", path)];
  assert.doesNotThrow(() => buildReviewMapPlannerInput(dataset(), largeUnit, [], {
    maxInputChars: 5_000,
  }));

  const input = buildReviewMapPlannerInput(dataset(), largeUnit, [], {
    maxInputChars: 5_000,
    repairInstructions: "\\\"".repeat(500),
  });
  const parsed = JSON.parse(input) as { repairInstructions: string };

  assert.ok(input.length <= 5_000);
  assert.ok(JSON.stringify(parsed.repairInstructions).length <= 500);
});

test("planner fails closed when complete unit identity cannot fit", () => {
  const oversized = [unit("large", `src/${"x".repeat(6_000)}.ts`)];

  assert.throws(
    () => buildReviewMapPlannerInput(dataset(), oversized, [], { maxInputChars: 5_000 }),
    /identity inventory exceeds/i,
  );
});
