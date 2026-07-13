import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileReviewMap } from "../src/review-map-compiler.js";
import { parseReviewMapPlan } from "../src/review-map-planner.js";
import type { ReviewChangeUnit } from "../src/types.js";

const fixtureRoot = resolve("tests/fixtures/review-maps/pr-664");

test("PR 664 fixture cannot collapse into service, tests, and miscellaneous buckets", () => {
  const units = JSON.parse(readFileSync(resolve(fixtureRoot, "units.json"), "utf8")) as ReviewChangeUnit[];
  const rawPlan = readFileSync(resolve(fixtureRoot, "planner-proposal.json"), "utf8");
  const plan = parseReviewMapPlan(rawPlan, units);
  const map = compileReviewMap({ sourceFingerprint: "sha256:pr-664", strategyVersion: "semantic-map-v1", plan, units, status: "semantic" });

  assert.ok(map.chapters.length >= 7 && map.chapters.length <= 9);
  assert.equal(map.chapters.some((chapter) => /^(tests?|miscellaneous changes|service behavior)$/i.test(chapter.title)), false);
  for (const expected of ["contract", "runtime", "graph", "search", "routing", "shutdown", "regression", "supporting"]) {
    assert.ok(map.chapters.some((chapter) => chapter.title.toLowerCase().includes(expected)), `missing ${expected} chapter`);
  }
  assert.equal(map.coverage.unmappedOriginalLineCount, 0);
  assert.equal(map.coverage.unmappedModifiedLineCount, 0);
  assert.equal(map.chapters.some((chapter) => chapter.visits.some((visit) => visit.role === "verification")), true);
});

test("golden corpus keeps small fixes compact and cross-cutting files splittable", () => {
  const corpus = JSON.parse(readFileSync(resolve("tests/fixtures/review-maps/corpus/cases.json"), "utf8")) as Array<{ id: string; expectedMaxChapters: number; permitsSplitFile: boolean }>;
  assert.equal(corpus.find((item) => item.id === "small-fix")?.expectedMaxChapters, 1);
  assert.equal(corpus.find((item) => item.id === "cross-cutting")?.permitsSplitFile, true);
  assert.deepEqual(corpus.map((item) => item.id), ["schema", "api", "deletion-heavy", "frontend", "small-fix", "cross-cutting"]);
});
