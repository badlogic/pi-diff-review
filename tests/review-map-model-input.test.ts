import assert from "node:assert/strict";
import test from "node:test";
import {
  largestFittingJson,
  projectReviewMapUnits,
  sanitizeReviewMapDiagnostic,
} from "../src/review-map-model-input.js";
import type { ReviewChangeUnit } from "../src/types.js";

const unit: ReviewChangeUnit = {
  id: "unit-a",
  fileId: "src/runtime.ts",
  path: "src/runtime.ts",
  symbol: "runReview",
  status: "modified",
  commitIds: ["abc123"],
  ranges: [
    { fileId: "src/runtime.ts", path: "src/runtime.ts", side: "original", startLine: 5, endLine: 6 },
    { fileId: "src/runtime.ts", path: "src/runtime.ts", side: "modified", startLine: 5, endLine: 9 },
  ],
};

test("model projection removes repeated range identity without losing canonical unit identity", () => {
  assert.deepEqual(projectReviewMapUnits([unit]), [{
    id: "unit-a",
    fileId: "src/runtime.ts",
    path: "src/runtime.ts",
    symbol: "runReview",
    status: "modified",
    commitIds: ["abc123"],
    ranges: [
      { side: "original", startLine: 5, endLine: 6 },
      { side: "modified", startLine: 5, endLine: 9 },
    ],
  }]);
});

test("exact JSON search accounts for escaped and multibyte input", () => {
  const value = Array.from({ length: 500 }, (_, index) => `line ${index} \\ \" λ\n`).join("");
  const fitted = largestFittingJson({
    maxInputChars: 1_000,
    maxVariableChars: value.length,
    build: (cap) => ({ patch: value.slice(0, cap) }),
  });

  assert.ok(fitted);
  assert.ok(fitted.input.length <= 1_000);
  assert.ok(JSON.stringify({ patch: value.slice(0, fitted.variableChars + 1) }).length > 1_000);
});

test("diagnostics are bounded and flatten model-controlled text", () => {
  const diagnostic = sanitizeReviewMapDiagnostic(new Error(`bad\n${"x".repeat(2_000)}`));

  assert.ok(diagnostic.length <= 500);
  assert.equal(diagnostic.includes("\n"), false);
});
