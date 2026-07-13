import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = readFileSync(resolve("web/app.js"), "utf8");
const html = readFileSync(resolve("web/index.html"), "utf8");

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

test("overall AI review remains visible inline and has a dedicated result canvas", () => {
  assert.match(html, /id="ai-review-result-container"/);
  assert.match(html, /aria-label="Open overall AI review"/);
  for (const label of [
    "Overall AI review",
    "AI review complete",
    "Validated findings",
    "Reviewed areas",
    "Suggested verdict",
    "Unresolved findings",
    "Accepted risks",
    "View full AI review",
    "Refresh AI analysis",
  ]) {
    assert.match(app, new RegExp(label));
  }
  assert.match(app, /buildAiReviewResultState/);
  assert.match(app, /renderSafeMarkdown\(result\.body\)/);
});

test("overall AI result actions reuse existing review workflows", () => {
  assert.match(app, /data-action="open-ai-review-result"/);
  assert.match(app, /data-action="run-ai-review"/);
  assert.match(app, /data-action="submit-review"/);
  assert.match(app, /runAiReviewFromUi\(\{ force: true \}\)/);
  assert.match(app, /submitReview\(\)/);
});

test("the header AI result trigger contains phrasing content only", () => {
  assert.match(html, /<button id="summary"/);
  assert.doesNotMatch(app, /summaryEl\.innerHTML = `\s*<div/);
  assert.match(app, /summaryEl\.innerHTML = `\s*<span/);
});

test("review completion pauses at chapter boundaries and ends on AI results", () => {
  assert.match(app, /firstUnreviewedVisitInChapter/);
  assert.match(app, /nextGuidedReviewDestination/);
  assert.match(app, /applyGuidedReviewDestination/);
  assert.match(app, /openChapterBrief\(destination\.chapterId\)/);
  assert.match(app, /openAiReviewResult\(\)/);
  assert.match(app, /Continue review/);
  assert.match(app, /data-review-visit-id/);
});
