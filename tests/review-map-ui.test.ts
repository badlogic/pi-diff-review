import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = readFileSync(resolve("web/app.js"), "utf8");

test("chapter brief presents a reviewer journey instead of a file bucket", () => {
  for (const label of ["Why this matters", "Questions to answer", "Review order", "Evidence and gaps", "Done when", "Start review"]) {
    assert.match(app, new RegExp(label));
  }
  assert.match(app, /chapter\.visits/);
  assert.match(app, /chapter\.reviewQuestions/);
  assert.match(app, /chapter\.exitCriteria/);
});

test("sticky file header and shortcuts expose semantic visit context", () => {
  assert.match(app, /humanizeToken\(activeVisit\.role\)/);
  assert.match(app, /Next review visit/);
  assert.match(app, /Complete review visit and advance/);
  assert.match(app, /nextReviewVisit\(reviewData\.map/);
});
