# Guided Chapter Transitions and Overall AI Review Result Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve chapter context during guided review and provide a durable, truthful overall AI review result inline and at the end of the review journey.

**Architecture:** Extend the existing `activeCanvas` state with an `ai-review` destination and keep chapter/file selection behavior intact. Put advancement policy and AI lifecycle normalization in small pure JavaScript modules with direct unit tests, then let `web/app.js` render the compact chapter card and expanded result page from those normalized values. Reuse the existing analysis payload, submission drawer, AI rerun action, and session fields; do not change host protocols or persisted schemas.

**Tech Stack:** JavaScript ES modules, TypeScript-aware `tsgo` checking, Node's built-in test runner through `tsx`, Monaco/Glimpse renderer, Tailwind-generated web CSS.

**Design reference:** `docs/superpowers/specs/2026-07-13-overall-ai-review-result-design.md`

---

## File Structure

- Create `web/ai-review-result-state.js`: normalize queued, running, complete, and failed AI review data into one truthful render model.
- Create `tests/ai-review-result-state.test.ts`: unit-test lifecycle precedence, zero findings, counts, verdicts, and stale-data suppression.
- Modify `web/review-navigation-state.js`: add pure semantic-visit advancement and first-unreviewed-visit helpers alongside the existing canvas predicate.
- Modify `tests/review-navigation-state.test.ts`: unit-test same-chapter, boundary, restored, split-file, out-of-order, completion, and invalid-current behavior.
- Modify `web/index.html`: make the header summary an accessible result-page trigger and add a dedicated result canvas container.
- Modify `web/app.js`: render both AI result surfaces, wire result actions, keep lifecycle updates visible, and apply guided destinations after `Reviewed`.
- Modify `web/review.css`: share overview animation and add reduced-motion-safe result presentation hooks.
- Modify `tests/review-map-ui.test.ts`: assert the renderer exposes the approved actions and destination wiring.
- Modify `tests/smoke.test.ts`: assert the packaged shell includes the dedicated result canvas and accessible header trigger.
- Regenerate `web/dist/review.js` and `web/dist/review.css` with `npm run build:web`; these are packaged artifacts and must match their sources.

## Task 1: Record the Approved Combined Design

**Files:**
- Add: `docs/superpowers/specs/2026-07-13-overall-ai-review-result-design.md`
- Add: `docs/superpowers/plans/2026-07-13-guided-chapter-transitions-ai-review-result.md`

- [ ] **Step 1: Check the documents for accidental omissions**

Run:

```bash
node -e 'const fs=require("node:fs");const paths=["docs/superpowers/specs/2026-07-13-overall-ai-review-result-design.md","docs/superpowers/plans/2026-07-13-guided-chapter-transitions-ai-review-result.md"];const needles=["TO"+"DO","TB"+"D","implement "+"later","fill in "+"details"];const hits=paths.flatMap((path)=>fs.readFileSync(path,"utf8").split("\n").flatMap((line,index)=>needles.some((needle)=>line.includes(needle))?[`${path}:${index+1}:${line}`]:[]));if(hits.length){console.error(hits.join("\n"));process.exit(1);}'
```

Expected: no output and exit status 0.

- [ ] **Step 2: Confirm the diff contains only the approved design and plan documents**

Run:

```bash
git status --short
git diff --no-index /dev/null docs/superpowers/specs/2026-07-13-overall-ai-review-result-design.md
git diff --no-index /dev/null docs/superpowers/plans/2026-07-13-guided-chapter-transitions-ai-review-result.md
```

Expected: the two named documents are untracked; the `--no-index` commands exit 1 because they display additions. The two pre-existing untracked semantic-map plan documents remain untouched and are not staged.

- [ ] **Step 3: Commit only the approved documents with signing enabled**

Run:

```bash
git add docs/superpowers/specs/2026-07-13-overall-ai-review-result-design.md docs/superpowers/plans/2026-07-13-guided-chapter-transitions-ai-review-result.md
git commit -S -m "docs: design guided review completion flow"
git log -1 --show-signature --format=fuller
```

Expected: the commit succeeds and `git log` reports a good signature for `docs: design guided review completion flow`.

## Task 2: Add the Pure Guided-Review Destination Policy

**Files:**
- Modify: `web/review-navigation-state.js`
- Modify: `tests/review-navigation-state.test.ts`

- [ ] **Step 1: Write failing destination-policy tests**

Replace the test import and append the following cases to `tests/review-navigation-state.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  firstUnreviewedVisitInChapter,
  isFileCanvasActive,
  nextGuidedReviewDestination,
} from "../web/review-navigation-state.js";

const chapters = [
  {
    id: "contract",
    visits: [
      { id: "contract-runtime", fileId: "src/runtime.py" },
      { id: "contract-tests", fileId: "tests/runtime.py" },
    ],
  },
  {
    id: "cleanup",
    visits: [
      { id: "cleanup-runtime", fileId: "src/runtime.py" },
      { id: "cleanup-docs", fileId: "docs/runtime.md" },
    ],
  },
  {
    id: "release",
    visits: [
      { id: "release-notes", fileId: "docs/release.md" },
    ],
  },
];

test("first unreviewed visit preserves semantic visit order", () => {
  assert.equal(firstUnreviewedVisitInChapter(chapters[0], {})?.id, "contract-runtime");
  assert.equal(
    firstUnreviewedVisitInChapter(chapters[0], { "contract-runtime": true })?.id,
    "contract-tests",
  );
  assert.equal(
    firstUnreviewedVisitInChapter(chapters[0], { "contract-runtime": true, "contract-tests": true }),
    null,
  );
});

test("guided review stays inside the current chapter while visits remain", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(chapters, { "contract-runtime": true }, "contract-runtime"),
    {
      kind: "visit",
      chapterId: "contract",
      visitId: "contract-tests",
      fileId: "tests/runtime.py",
    },
  );
});

test("guided review pauses on the next incomplete chapter overview", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      { "contract-runtime": true, "contract-tests": true },
      "contract-tests",
    ),
    { kind: "chapter", chapterId: "cleanup" },
  );
});

test("guided review skips complete later chapters", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      {
        "contract-runtime": true,
        "contract-tests": true,
        "cleanup-runtime": true,
        "cleanup-docs": true,
      },
      "contract-tests",
    ),
    { kind: "chapter", chapterId: "release" },
  );
});

test("guided review handles two visits for the same file by visit identity", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      {
        "contract-runtime": true,
        "contract-tests": true,
        "cleanup-runtime": true,
      },
      "cleanup-runtime",
    ),
    {
      kind: "visit",
      chapterId: "cleanup",
      visitId: "cleanup-docs",
      fileId: "docs/runtime.md",
    },
  );
});

test("out-of-order completion wraps to an earlier incomplete chapter", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      {
        "contract-runtime": true,
        "cleanup-runtime": true,
        "cleanup-docs": true,
        "release-notes": true,
      },
      "release-notes",
    ),
    { kind: "chapter", chapterId: "contract" },
  );
});

test("the final outstanding visit advances to the overall AI result", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(
      chapters,
      {
        "contract-runtime": true,
        "contract-tests": true,
        "cleanup-runtime": true,
        "cleanup-docs": true,
        "release-notes": true,
      },
      "release-notes",
    ),
    { kind: "ai-review" },
  );
});

test("an unknown current visit never guesses a destination", () => {
  assert.deepEqual(
    nextGuidedReviewDestination(chapters, {}, "missing-visit"),
    { kind: "stay", reason: "active-visit-not-found" },
  );
});
```

Keep the existing `isFileCanvasActive` test at the top of the file; do not duplicate its imports.

- [ ] **Step 2: Run the focused test and verify the new API is missing**

Run:

```bash
npx tsx --test tests/review-navigation-state.test.ts
```

Expected: FAIL because `firstUnreviewedVisitInChapter` and `nextGuidedReviewDestination` are not exported.

- [ ] **Step 3: Implement the minimal pure policy**

Append this implementation to `web/review-navigation-state.js`:

```js
function chapterVisits(chapter) {
  return Array.isArray(chapter?.visits) ? chapter.visits : [];
}

function hasUnreviewedVisit(chapter, reviewedVisits) {
  return chapterVisits(chapter).some((visit) => reviewedVisits?.[visit.id] !== true);
}

export function firstUnreviewedVisitInChapter(chapter, reviewedVisits) {
  return chapterVisits(chapter).find((visit) => reviewedVisits?.[visit.id] !== true) || null;
}

export function nextGuidedReviewDestination(chapters, reviewedVisits, activeVisitId) {
  const orderedChapters = Array.isArray(chapters) ? chapters : [];
  const currentChapterIndex = orderedChapters.findIndex((chapter) =>
    chapterVisits(chapter).some((visit) => visit.id === activeVisitId)
  );
  if (currentChapterIndex < 0) {
    return { kind: "stay", reason: "active-visit-not-found" };
  }

  const currentChapter = orderedChapters[currentChapterIndex];
  const nextVisit = chapterVisits(currentChapter).find((visit) =>
    visit.id !== activeVisitId && reviewedVisits?.[visit.id] !== true
  );
  if (nextVisit) {
    return {
      kind: "visit",
      chapterId: currentChapter.id,
      visitId: nextVisit.id,
      fileId: nextVisit.fileId,
    };
  }

  const laterChapter = orderedChapters
    .slice(currentChapterIndex + 1)
    .find((chapter) => hasUnreviewedVisit(chapter, reviewedVisits));
  if (laterChapter) return { kind: "chapter", chapterId: laterChapter.id };

  const earlierChapter = orderedChapters
    .slice(0, currentChapterIndex)
    .find((chapter) => hasUnreviewedVisit(chapter, reviewedVisits));
  if (earlierChapter) return { kind: "chapter", chapterId: earlierChapter.id };

  return { kind: "ai-review" };
}
```

- [ ] **Step 4: Run focused navigation tests**

Run:

```bash
npx tsx --test tests/review-navigation-state.test.ts
```

Expected: all navigation-state tests PASS.

- [ ] **Step 5: Type-check the new public functions**

Run:

```bash
npm run check
```

Expected: `tsgo --noEmit --allowJs` exits 0.

- [ ] **Step 6: Commit the pure policy with a verified signature**

Run:

```bash
git add web/review-navigation-state.js tests/review-navigation-state.test.ts
git commit -S -m "feat: add guided review destination policy"
git log -1 --show-signature --format=fuller
```

Expected: the commit succeeds and reports a good signature.

## Task 3: Normalize Overall AI Review Lifecycle Data

**Files:**
- Create: `web/ai-review-result-state.js`
- Create: `tests/ai-review-result-state.test.ts`

- [ ] **Step 1: Write lifecycle-model tests**

Create `tests/ai-review-result-state.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildAiReviewResultState } from "../web/ai-review-result-state.js";

const approvalPacket = {
  summary: "The implementation is ready for review.",
  body: "The changed behavior is covered by focused tests.",
  reviewedChapters: ["contract", "cleanup"],
  acceptedRisks: ["A manual release check remains."],
  unresolvedFindings: [],
  suggestedVerdict: "approve",
};

test("completed zero-finding analysis remains an explicit result", () => {
  assert.deepEqual(
    buildAiReviewResultState({
      aiReview: { status: "done", message: "AI review complete." },
      aiReviewCompleted: true,
      analysis: { findings: [], approvalPacket },
    }),
    {
      lifecycle: "complete",
      statusLabel: "AI review complete",
      message: "AI review complete.",
      progress: null,
      findingCount: 0,
      reviewedAreaCount: 2,
      verdict: "approve",
      verdictLabel: "Approve",
      summary: "The implementation is ready for review.",
      body: "The changed behavior is covered by focused tests.",
      acceptedRisks: ["A manual release check remains."],
      unresolvedFindings: [],
    },
  );
});

test("a restored completion bit preserves a zero-finding result", () => {
  const result = buildAiReviewResultState({
    aiReview: { status: "idle", message: "AI analysis complete." },
    aiReviewCompleted: true,
    analysis: { findings: [], approvalPacket },
  });
  assert.equal(result.lifecycle, "complete");
  assert.equal(result.findingCount, 0);
  assert.equal(result.verdictLabel, "Approve");
});

test("validated findings and request-changes verdict are counted", () => {
  const result = buildAiReviewResultState({
    aiReview: { status: "done" },
    aiReviewCompleted: true,
    analysis: {
      findings: [{ id: "finding-1" }, { id: "finding-2" }],
      approvalPacket: { ...approvalPacket, suggestedVerdict: "request-changes" },
    },
  });
  assert.equal(result.findingCount, 2);
  assert.equal(result.verdictLabel, "Request changes");
});

test("running analysis suppresses stale completion details", () => {
  const result = buildAiReviewResultState({
    aiReview: {
      status: "running",
      message: "Validating findings...",
      progress: { phase: "validation" },
    },
    aiReviewCompleted: false,
    analysis: { findings: [{ id: "finding-1" }], approvalPacket },
  });
  assert.equal(result.lifecycle, "running");
  assert.equal(result.statusLabel, "AI review in progress");
  assert.equal(result.findingCount, 1);
  assert.equal(result.verdict, null);
  assert.equal(result.summary, "");
  assert.equal(result.body, "");
  assert.deepEqual(result.acceptedRisks, []);
  assert.deepEqual(result.unresolvedFindings, []);
});

test("failure takes precedence over the completion persistence bit", () => {
  const result = buildAiReviewResultState({
    aiReview: { status: "failed", message: "The model request timed out." },
    aiReviewCompleted: true,
    analysis: { findings: [{ id: "partial-finding" }], approvalPacket },
  });
  assert.equal(result.lifecycle, "failed");
  assert.equal(result.statusLabel, "AI review incomplete");
  assert.equal(result.message, "The model request timed out.");
  assert.equal(result.findingCount, 1);
  assert.equal(result.verdict, null);
  assert.equal(result.summary, "");
});

test("idle analysis is queued and has safe empty values", () => {
  const result = buildAiReviewResultState({});
  assert.equal(result.lifecycle, "queued");
  assert.equal(result.statusLabel, "AI review queued");
  assert.equal(result.message, "AI analysis will run in the background.");
  assert.equal(result.findingCount, 0);
  assert.equal(result.reviewedAreaCount, 0);
  assert.equal(result.verdictLabel, "");
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run:

```bash
npx tsx --test tests/ai-review-result-state.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/ai-review-result-state.js`.

- [ ] **Step 3: Implement the normalized result model**

Create `web/ai-review-result-state.js` with:

```js
const verdictLabels = Object.freeze({
  approve: "Approve",
  comment: "Comment",
  "request-changes": "Request changes",
});

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function lifecycleFor(aiReview, aiReviewCompleted) {
  if (aiReview?.status === "failed") return "failed";
  if (aiReview?.status === "running") return "running";
  if (aiReview?.status === "done" || aiReviewCompleted === true) return "complete";
  return "queued";
}

function statusLabelFor(lifecycle) {
  return {
    queued: "AI review queued",
    running: "AI review in progress",
    complete: "AI review complete",
    failed: "AI review incomplete",
  }[lifecycle];
}

function defaultMessageFor(lifecycle) {
  return {
    queued: "AI analysis will run in the background.",
    running: "AI review is running.",
    complete: "AI review complete.",
    failed: "AI review failed before producing a complete result.",
  }[lifecycle];
}

export function buildAiReviewResultState(input = {}) {
  const aiReview = input.aiReview || {};
  const analysis = input.analysis || {};
  const approvalPacket = analysis.approvalPacket || {};
  const lifecycle = lifecycleFor(aiReview, input.aiReviewCompleted);
  const complete = lifecycle === "complete";
  const verdict = complete && verdictLabels[approvalPacket.suggestedVerdict]
    ? approvalPacket.suggestedVerdict
    : null;

  return {
    lifecycle,
    statusLabel: statusLabelFor(lifecycle),
    message: typeof aiReview.message === "string" && aiReview.message.length > 0
      ? aiReview.message
      : defaultMessageFor(lifecycle),
    progress: aiReview.progress || null,
    findingCount: Array.isArray(analysis.findings) ? analysis.findings.length : 0,
    reviewedAreaCount: complete ? stringArray(approvalPacket.reviewedChapters).length : 0,
    verdict,
    verdictLabel: verdict ? verdictLabels[verdict] : "",
    summary: complete && typeof approvalPacket.summary === "string" ? approvalPacket.summary : "",
    body: complete && typeof approvalPacket.body === "string" ? approvalPacket.body : "",
    acceptedRisks: complete ? stringArray(approvalPacket.acceptedRisks) : [],
    unresolvedFindings: complete ? stringArray(approvalPacket.unresolvedFindings) : [],
  };
}
```

- [ ] **Step 4: Run focused and static checks**

Run:

```bash
npx tsx --test tests/ai-review-result-state.test.ts
npm run check
```

Expected: all lifecycle tests PASS and `tsgo` exits 0.

- [ ] **Step 5: Commit the result model with a verified signature**

Run:

```bash
git add web/ai-review-result-state.js tests/ai-review-result-state.test.ts
git commit -S -m "feat: normalize overall AI review results"
git log -1 --show-signature --format=fuller
```

Expected: the commit succeeds and reports a good signature.

## Task 4: Render the Compact Card and Expanded Result Canvas

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/review.css`
- Modify: `tests/review-map-ui.test.ts`
- Modify: `tests/smoke.test.ts`

- [ ] **Step 1: Write failing renderer contract tests**

At the top of `tests/review-map-ui.test.ts`, read the shell alongside the app source:

```ts
const app = readFileSync(resolve("web/app.js"), "utf8");
const html = readFileSync(resolve("web/index.html"), "utf8");
```

Append these tests:

```ts
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
```

In the existing shell assertions in `tests/smoke.test.ts`, add:

```ts
assert.equal(html.includes('id="ai-review-result-container"'), true);
assert.equal(html.includes('aria-label="Open overall AI review"'), true);
assert.equal(appJs.includes("mountAiReviewResult"), true);
assert.equal(appJs.includes('activeCanvas === "ai-review"'), true);
```

- [ ] **Step 2: Run the focused UI tests and verify the new surface is absent**

Run:

```bash
npx tsx --test tests/review-map-ui.test.ts tests/smoke.test.ts
```

Expected: FAIL on the missing result container, header label, renderer functions, and result labels.

- [ ] **Step 3: Add the dedicated canvas and accessible header trigger**

In `web/index.html`, change the header summary element to a button:

```html
<button id="summary" type="button" aria-label="Open overall AI review" title="Open overall AI review" class="hidden min-w-0 max-w-[34rem] cursor-pointer rounded px-1 py-0.5 text-left text-[11px] text-review-muted hover:bg-[#161b22] hover:text-review-text xl:block"></button>
```

Add the dedicated canvas immediately after `chapter-brief-container`:

```html
<div id="ai-review-result-container" class="ai-review-result-view scrollbar-thin hidden min-h-0 min-w-0 flex-1 overflow-auto bg-[#0d1117]"></div>
```

- [ ] **Step 4: Import the result model and register the canvas element**

Add this import near the other local state modules in `web/app.js`:

```js
import { buildAiReviewResultState } from "./ai-review-result-state.js";
```

Add this DOM lookup beside the chapter brief lookup:

```js
const aiReviewResultContainerEl = document.getElementById("ai-review-result-container");
```

Add `pendingCanvasFocus: null` beside `activeCanvas: "file"` in the initial state.

- [ ] **Step 5: Add truthful compact and expanded renderers**

Add the following helpers immediately before `chapterBriefHtml` in `web/app.js`:

```js
function currentAiReviewResult() {
  return buildAiReviewResultState({
    aiReview: state.aiReview,
    aiReviewCompleted: state.aiReviewCompleted,
    analysis: reviewData.analysis,
  });
}

function aiReviewStatusClass(lifecycle) {
  if (lifecycle === "complete") return "border-[#238636]/50 bg-[#238636]/15 text-[#3fb950]";
  if (lifecycle === "failed") return "border-[#f85149]/40 bg-[#f85149]/10 text-[#ff7b72]";
  return "border-[#8957e5]/40 bg-[#8957e5]/10 text-[#d2a8ff]";
}

function aiReviewRunLabel(lifecycle) {
  if (lifecycle === "failed") return "Retry AI review";
  if (lifecycle === "queued") return "Run AI review";
  return "Refresh AI analysis";
}

function aiReviewProgressHtml(result) {
  if (result.lifecycle !== "running") return "";
  return `<span class="inline-flex items-center gap-1" aria-label="AI review running"><span class="ai-pulse-dot"></span><span class="ai-pulse-dot"></span><span class="ai-pulse-dot"></span></span>`;
}

function aiReviewListHtml(items, emptyMessage) {
  if (items.length === 0) return `<p class="text-sm text-review-muted">${escapeHtml(emptyMessage)}</p>`;
  return `<ul class="space-y-2 text-sm leading-6 text-review-text">${items.map((item) => `<li class="flex gap-2"><span class="text-[#d2a8ff]">•</span><span>${escapeHtml(item)}</span></li>`).join("")}</ul>`;
}

function overallAiReviewCardHtml() {
  const result = currentAiReviewResult();
  const complete = result.lifecycle === "complete";
  return `
    <section class="mb-4 rounded-lg border border-[#8957e5]/35 bg-[#8957e5]/[0.06] p-4" aria-labelledby="overall-ai-review-card-title">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div id="overall-ai-review-card-title" class="text-[11px] font-semibold uppercase tracking-wider text-[#d2a8ff]">Overall AI review</div>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <span class="rounded border px-2 py-1 text-xs font-semibold ${aiReviewStatusClass(result.lifecycle)}">${escapeHtml(result.statusLabel)}</span>
            ${aiReviewProgressHtml(result)}
            ${complete ? `<span class="text-xs text-review-muted">${result.findingCount} validated finding${result.findingCount === 1 ? "" : "s"} · ${result.reviewedAreaCount} reviewed area${result.reviewedAreaCount === 1 ? "" : "s"} · ${escapeHtml(result.verdictLabel)}</span>` : ""}
          </div>
          <p class="mt-3 text-sm leading-6 text-review-text">${escapeHtml(complete ? result.summary || "AI review completed without an overall summary." : result.message)}</p>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" data-action="open-ai-review-result" class="cursor-pointer rounded-md border border-review-border bg-[#161b22] px-3 py-1.5 text-xs font-semibold text-review-text hover:bg-[#21262d]">View full AI review</button>
          ${result.lifecycle === "running" ? "" : `<button type="button" data-action="run-ai-review" data-ai-review-surface-action data-idle-label="${escapeHtml(aiReviewRunLabel(result.lifecycle))}" class="cursor-pointer rounded-md border border-[#8957e5]/40 bg-[#8957e5]/10 px-3 py-1.5 text-xs font-semibold text-[#d2a8ff] hover:bg-[#8957e5]/20">${escapeHtml(aiReviewRunLabel(result.lifecycle))}</button>`}
        </div>
      </div>
    </section>
  `;
}

function overallAiReviewResultHtml() {
  const result = currentAiReviewResult();
  const complete = result.lifecycle === "complete";
  return `
    <div class="mx-auto w-full max-w-5xl px-8 py-8">
      <div class="border-b border-review-border pb-6">
        <span class="inline-flex rounded border px-2 py-1 text-xs font-semibold ${aiReviewStatusClass(result.lifecycle)}">${escapeHtml(result.statusLabel)}</span>
        <h1 data-canvas-heading tabindex="-1" class="mt-3 text-2xl font-semibold text-white outline-none">Overall AI review</h1>
        <p class="mt-3 max-w-3xl text-sm leading-6 text-review-muted">${escapeHtml(complete ? result.summary || "AI review completed without an overall summary." : result.message)}</p>
      </div>

      <div class="mt-6 grid gap-3 sm:grid-cols-3">
        <div class="rounded-lg border border-review-border bg-[#010409] p-4">
          <div class="text-xl font-semibold text-white">${result.findingCount}</div>
          <div class="mt-1 text-[11px] uppercase tracking-wider text-review-muted">Validated findings</div>
        </div>
        <div class="rounded-lg border border-review-border bg-[#010409] p-4">
          <div class="text-xl font-semibold text-white">${complete ? result.reviewedAreaCount : "—"}</div>
          <div class="mt-1 text-[11px] uppercase tracking-wider text-review-muted">Reviewed areas</div>
        </div>
        <div class="rounded-lg border border-review-border bg-[#010409] p-4">
          <div class="text-xl font-semibold text-white">${escapeHtml(complete ? result.verdictLabel : "Pending")}</div>
          <div class="mt-1 text-[11px] uppercase tracking-wider text-review-muted">Suggested verdict</div>
        </div>
      </div>

      ${complete ? `
        <section class="mt-4 rounded-lg border border-review-border bg-[#010409] p-5">
          <h2 class="text-sm font-semibold text-white">AI recommendation</h2>
          <div class="review-context-markdown mt-3">${result.body ? renderSafeMarkdown(result.body) : `<p>No detailed recommendation was provided.</p>`}</div>
        </section>
        <div class="mt-4 grid gap-4 lg:grid-cols-2">
          <section class="rounded-lg border border-review-border bg-[#010409] p-5">
            <h2 class="mb-3 text-sm font-semibold text-white">Unresolved findings</h2>
            ${aiReviewListHtml(result.unresolvedFindings, "No unresolved AI findings.")}
          </section>
          <section class="rounded-lg border border-review-border bg-[#010409] p-5">
            <h2 class="mb-3 text-sm font-semibold text-white">Accepted risks</h2>
            ${aiReviewListHtml(result.acceptedRisks, "No accepted risks were recorded.")}
          </section>
        </div>
      ` : `
        <section class="mt-4 rounded-lg border border-review-border bg-[#010409] p-5" role="status" aria-live="polite">
          <div class="flex items-center gap-2"><h2 class="text-sm font-semibold text-white">${escapeHtml(result.statusLabel)}</h2>${aiReviewProgressHtml(result)}</div>
          <p class="mt-2 text-sm leading-6 text-review-muted">${escapeHtml(result.message)}</p>
        </section>
      `}

      <div class="mt-6 flex flex-wrap justify-end gap-2 border-t border-review-border pt-5">
        ${result.lifecycle === "running" ? "" : `<button type="button" data-action="run-ai-review" data-ai-review-surface-action data-idle-label="${escapeHtml(aiReviewRunLabel(result.lifecycle))}" class="cursor-pointer rounded-md border border-review-border bg-[#161b22] px-4 py-2 text-sm font-semibold text-review-text hover:bg-[#21262d]">${escapeHtml(aiReviewRunLabel(result.lifecycle))}</button>`}
        <button type="button" data-action="submit-review" class="cursor-pointer rounded-md border border-[#1f6feb]/40 bg-[#1f6feb] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388bfd]">Submit review</button>
      </div>
    </div>
  `;
}
```

Insert `${overallAiReviewCardHtml()}` in `chapterBriefHtml` immediately after the chapter header and before the two-column `Why this matters` / `AI findings` grid. Add `data-canvas-heading tabindex="-1"` to the chapter `<h1>`.

- [ ] **Step 6: Mount and open the result canvas**

Add these functions beside `openChapterBrief` and `mountChapterBrief`:

```js
function openAiReviewResult() {
  saveCurrentScrollPosition();
  state.activeCanvas = "ai-review";
  state.activeInsight = { type: "default", id: null };
  state.pendingCanvasFocus = "ai-review";
  renderAll({ restoreFileScroll: false });
  return true;
}

function bindAiReviewSurfaceActions(container) {
  container.querySelectorAll('[data-action="open-ai-review-result"]').forEach((button) => {
    button.addEventListener("click", openAiReviewResult);
  });
  container.querySelectorAll('[data-action="run-ai-review"]').forEach((button) => {
    button.addEventListener("click", () => runAiReviewFromUi({ force: true }));
  });
  container.querySelectorAll('[data-action="submit-review"]').forEach((button) => {
    button.addEventListener("click", () => submitReview());
  });
}

function clearFileCanvasForOverview() {
  clearViewZones();
  if (diffEditor) {
    originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, []);
    modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, []);
    originalKeyboardDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalKeyboardDecorations, []);
    modifiedKeyboardDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedKeyboardDecorations, []);
  }
  editorContainerEl.classList.add("hidden");
  fileCommentsContainer.className = "hidden border-b border-review-border bg-[#0d1117] px-4 py-0";
}

function mountAiReviewResult() {
  clearFileCanvasForOverview();
  chapterBriefContainerEl.classList.add("hidden");
  aiReviewResultContainerEl.classList.remove("hidden");
  currentFileLabelEl.textContent = "Overall AI review";
  modeHintEl.textContent = currentAiReviewResult().statusLabel;
  aiReviewResultContainerEl.innerHTML = overallAiReviewResultHtml();
  bindAiReviewSurfaceActions(aiReviewResultContainerEl);
  updateToggleButtons();
  if (state.pendingCanvasFocus === "ai-review") {
    state.pendingCanvasFocus = null;
    requestAnimationFrame(() => aiReviewResultContainerEl.querySelector("[data-canvas-heading]")?.focus());
  }
}
```

Refactor `mountChapterBrief` to call `clearFileCanvasForOverview()`, hide `aiReviewResultContainerEl`, show `chapterBriefContainerEl`, call `bindAiReviewSurfaceActions(chapterBriefContainerEl)`, and consume `state.pendingCanvasFocus === "chapter"` by focusing its `[data-canvas-heading]` once.

Update `openChapterBrief` to set `state.pendingCanvasFocus = "chapter"` before `renderAll`.

Update `mountFile` to hide both overview containers before showing the editor:

```js
chapterBriefContainerEl.classList.add("hidden");
aiReviewResultContainerEl.classList.add("hidden");
editorContainerEl.classList.remove("hidden");
```

Update `renderAll` so the AI result branch is evaluated before the chapter branch:

```js
if (state.activeCanvas === "ai-review") {
  mountAiReviewResult();
  return;
}
```

Update `updateToggleButtons` to use `state.activeCanvas !== "file"` for the overview-toolbar branch so file-only actions remain hidden on both overview types.

Update `updateAiReviewButton` so the existing toolbar control retains its current behavior while result-surface buttons keep their explicit labels and classes:

```js
function updateAiReviewButton() {
  const running = state.aiReview.status === "running";
  document.querySelectorAll("[data-action='run-ai-review']").forEach((button) => {
    button.disabled = running;
    if (button.hasAttribute("data-ai-review-surface-action")) {
      button.textContent = running ? "AI review running" : button.dataset.idleLabel || "Refresh AI analysis";
      button.classList.toggle("opacity-70", running);
      return;
    }
    button.textContent = running ? "..." : "Refresh";
    button.title = "Refresh AI analysis";
    button.className = running
      ? "shrink-0 cursor-default rounded px-2 py-1 text-[11px] font-medium text-review-muted opacity-70"
      : "shrink-0 cursor-pointer rounded px-2 py-1 text-[11px] font-medium text-review-muted hover:bg-[#21262d] hover:text-review-text";
  });
}
```

- [ ] **Step 7: Keep active overview surfaces current during AI events**

Add this helper near `renderAll`:

```js
function refreshVisibleAiReviewSurface() {
  renderTree();
  if (state.activeCanvas === "ai-review") {
    mountAiReviewResult();
    return;
  }
  if (state.activeCanvas === "chapter" && state.activeInsight.type === "chapter") {
    const chapter = getReviewChapter(state.activeInsight.id);
    if (chapter) mountChapterBrief(chapter);
  }
}
```

Use `refreshVisibleAiReviewSurface()` instead of `renderTree()` in:

- both render paths in `runAiReviewFromUi`: the unavailable-host failure path and the normal running path;
- the `ai-review-progress` host-message branch;
- the `ai-review-error` host-message branch; and
- the `ai-review-partial-result` branch before its existing file-view decoration refresh.

Keep `renderAll({ preserveScroll: true })` for the final `ai-review-result` branch so every active canvas receives final data.

- [ ] **Step 8: Wire the header and add shared motion styling**

Add this event listener near the other persistent header listeners:

```js
summaryEl.addEventListener("click", openAiReviewResult);
```

In `web/review.css`, share the existing overview entrance animation:

```css
.chapter-brief-view,
.ai-review-result-view {
  animation: chapter-brief-in 160ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

Add `.ai-review-result-view` to the existing reduced-motion selector that disables `.chapter-brief-view` animation.

- [ ] **Step 9: Run focused tests, type-check, and build packaged assets**

Run:

```bash
npx tsx --test tests/ai-review-result-state.test.ts tests/review-map-ui.test.ts tests/smoke.test.ts
npm run check
npm run build:web
npx tsx --test tests/web-package.test.ts
```

Expected: all focused tests PASS, `tsgo` exits 0, the web build succeeds, and package tests PASS.

- [ ] **Step 10: Commit result surfaces and generated assets with a verified signature**

Run:

```bash
git add web/index.html web/app.js web/review.css web/dist/review.js web/dist/review.css tests/review-map-ui.test.ts tests/smoke.test.ts
git commit -S -m "feat: show overall AI review results"
git log -1 --show-signature --format=fuller
```

Expected: the commit succeeds and reports a good signature.

## Task 5: Apply Guided Navigation at Semantic-Visit Boundaries

**Files:**
- Modify: `web/app.js`
- Modify: `tests/review-map-ui.test.ts`

- [ ] **Step 1: Write failing app-wiring assertions**

Append this test to `tests/review-map-ui.test.ts`:

```ts
test("review completion pauses at chapter boundaries and ends on AI results", () => {
  assert.match(app, /firstUnreviewedVisitInChapter/);
  assert.match(app, /nextGuidedReviewDestination/);
  assert.match(app, /applyGuidedReviewDestination/);
  assert.match(app, /openChapterBrief\(destination\.chapterId\)/);
  assert.match(app, /openAiReviewResult\(\)/);
  assert.match(app, /Continue review/);
  assert.match(app, /data-review-visit-id/);
});
```

- [ ] **Step 2: Run the focused UI test and verify wiring is absent**

Run:

```bash
npx tsx --test tests/review-map-ui.test.ts
```

Expected: FAIL because the guided destination functions are not imported or applied and `Continue review` is absent.

- [ ] **Step 3: Import the guided-navigation helpers**

Replace the existing `review-navigation-state.js` import in `web/app.js` with:

```js
import {
  firstUnreviewedVisitInChapter,
  isFileCanvasActive,
  nextGuidedReviewDestination,
} from "./review-navigation-state.js";
```

- [ ] **Step 4: Add destination application helpers**

Add these functions beside `openChapterBrief`:

```js
function getReviewVisit(visitId) {
  for (const chapter of getReviewChapters()) {
    const visit = (chapter.visits || []).find((item) => item.id === visitId);
    if (visit) return visit;
  }
  return null;
}

function openReviewVisit(visitId) {
  const visit = getReviewVisit(visitId);
  if (!visit || !getFileById(visit.fileId)) return false;
  state.activeVisitId = visit.id;
  openFile(visit.fileId);
  requestAnimationFrame(focusDiffPane);
  return true;
}

function applyGuidedReviewDestination(destination) {
  if (destination.kind === "visit") return openReviewVisit(destination.visitId);
  if (destination.kind === "chapter") return openChapterBrief(destination.chapterId);
  if (destination.kind === "ai-review") return openAiReviewResult();
  return false;
}
```

- [ ] **Step 5: Make the chapter action start at the first outstanding visit**

In `chapterBriefHtml`, replace `firstFileId` with a semantic-first action that retains the existing fallback for older maps without visits:

```js
const firstUnreviewedVisit = firstUnreviewedVisitInChapter(chapter, state.reviewedVisits);
const firstUnreviewedFile = firstUnreviewedVisit ? getFileById(firstUnreviewedVisit.fileId) : null;
const firstUnreviewedLegacyFile = visits.length === 0
  ? files.find((file) => !isFileReviewed(file.id)) || null
  : null;
const chapterActionFile = firstUnreviewedFile || firstUnreviewedLegacyFile;
const chapterActionLabel = progress.reviewed > 0 ? "Continue review" : "Start review";
```

Replace the current `Start review` button expression with:

```js
${chapterActionFile ? `<button type="button" data-open-chapter-file="${escapeHtml(chapterActionFile.id)}"${firstUnreviewedVisit ? ` data-review-visit-id="${escapeHtml(firstUnreviewedVisit.id)}"` : ""} class="cursor-pointer rounded-md border border-[#1f6feb]/40 bg-[#1f6feb] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#388bfd]">${escapeHtml(chapterActionLabel)}</button>` : `<span class="rounded-md border border-[#238636]/40 bg-[#238636]/10 px-3 py-1.5 text-xs font-semibold text-[#3fb950]">Chapter complete</span>`}
```

Keep the review-order buttons' explicit `data-review-visit-id` values so manual selection opens the exact semantic visit even when the same file occurs in more than one chapter.

- [ ] **Step 6: Replace cross-chapter file jumping after `Reviewed`**

In the active-visit branch of `toggleCurrentFileReviewed`, replace the `nextReviewVisit` auto-advance block with:

```js
if (state.reviewedVisits[activeVisit.id] === true) {
  const destination = nextGuidedReviewDestination(
    getReviewChapters(),
    state.reviewedVisits,
    activeVisit.id,
  );
  if (applyGuidedReviewDestination(destination)) return;
}
```

Leave `moveReviewVisit(direction)` on `nextReviewVisit`; bracket-key navigation is explicit manual navigation and should continue moving directly between visits. Leave the no-active-visit legacy file fallback intact for non-semantic maps.

- [ ] **Step 7: Make chapter keyboard navigation open overviews**

Replace the file-opening body of `openChapterByIndex` with:

```js
return openChapterBrief(chapter.id);
```

This makes explicit next/previous chapter commands consistent with sidebar chapter selection without changing visit-level bracket navigation.

- [ ] **Step 8: Run navigation, renderer, and type checks**

Run:

```bash
npx tsx --test tests/review-navigation-state.test.ts tests/review-map-ui.test.ts tests/review-visit-state.test.ts
npm run check
npm run build:web
npx tsx --test tests/web-package.test.ts tests/smoke.test.ts
```

Expected: all focused tests PASS, `tsgo` exits 0, the web build succeeds, and the packaged shell tests PASS.

- [ ] **Step 9: Commit guided transitions and generated assets with a verified signature**

Run:

```bash
git add web/app.js web/dist/review.js web/dist/review.css tests/review-map-ui.test.ts
git commit -S -m "feat: pause guided review at chapter boundaries"
git log -1 --show-signature --format=fuller
```

Expected: the commit succeeds and reports a good signature.

## Task 6: Verify the Entire Product and Test PR #669

**Files:**
- Verify only; change files only if a failing test exposes a defect covered by this specification.

- [ ] **Step 1: Run the complete automated verification suite**

Run:

```bash
npm test
npm run check
npm run build:web
git diff --check
```

Expected: every test passes, `tsgo` exits 0, the build succeeds, and `git diff --check` emits no output.

- [ ] **Step 2: Verify generated web assets are reproducible**

Run:

```bash
git status --short
npm run build:web
git status --short
```

Expected: the second status is identical to the first; rebuilding introduces no new diff.

- [ ] **Step 3: Pack and refresh the user's installed CLI from this branch**

Run:

```bash
rm -f /tmp/pi-diff-review-cockpit-0.1.0.tgz
npm pack --pack-destination /tmp
npm install -g /tmp/pi-diff-review-cockpit-0.1.0.tgz
pi-diff-review --version
pi-diff-review --help
```

Expected: packing and global installation succeed, the version is `0.1.0`, and help lists the `pr <url-or-number>` command.

- [ ] **Step 4: Launch a clean live review run for PR #669**

Run from the Magellan checkout:

```bash
cd /Users/kewalzanzmeria/Desktop/ho-repos/magellan
pi-diff-review --reset-review pr https://github.com/headout/magellan/pull/669
```

Expected: the viewer opens for headout/magellan PR #669, produces the semantic review map, and starts AI analysis. Do not publish or submit a GitHub review during this smoke test.

- [ ] **Step 5: Exercise the approved workflow in the live viewer**

Verify all of the following in order:

1. A chapter overview shows the compact **Overall AI review** card while AI analysis is queued or running.
2. Marking a non-final visit `Reviewed` opens the next outstanding visit in the same chapter.
3. Marking the final visit in that chapter opens the next incomplete chapter overview, not its first diff.
4. The overview action reads `Start review` for untouched chapters and `Continue review` for partially reviewed chapters.
5. A file represented by more than one semantic visit opens the visit selected in the chapter review order.
6. The header AI status opens the expanded overall AI result without changing reviewed state.
7. When AI analysis completes with zero findings, both result surfaces explicitly show `0 validated findings`, the reviewed-area count, verdict, summary, and recommendation.
8. The expanded page shows empty unresolved-findings and accepted-risks states instead of omitting the sections.
9. `Refresh AI analysis` keeps the expanded page open while its status changes to running and back to complete or failed.
10. Completing the final outstanding visit opens the expanded overall AI result page.
11. `Submit review` opens the existing GitHub submission drawer; close it without publishing.

Expected: all checks pass with no blank canvas, stale completion verdict, skipped outstanding visit, duplicate visit, or automatic GitHub publication.

- [ ] **Step 6: Inspect the persisted session metadata after the smoke run**

Run:

```bash
node -e 'const fs=require("node:fs");const p="/Users/kewalzanzmeria/Desktop/ho-repos/magellan/.git/pi-diff-review-cockpit/reviews/github-headout-magellan-pull-669-0f87c680bbce00ef/session.json";const s=JSON.parse(fs.readFileSync(p,"utf8"));console.log(JSON.stringify({reviewedVisits:s.snapshot?.reviewedVisits,aiReviewCompleted:s.snapshot?.aiReviewCompleted,aiReviewStatus:s.snapshot?.aiReviewStatus,approvalPacket:s.snapshot?.analysis?.approvalPacket},null,2));'
```

Expected: reviewed semantic visit IDs are retained, `aiReviewCompleted` is true after completion, `aiReviewStatus` is `done` or truthfully `failed`, and the approval packet contains the overall result rendered in the viewer.

- [ ] **Step 7: Verify every new branch commit before any push**

Run:

```bash
git log main..HEAD --show-signature --format=fuller
```

Expected: every commit added by this branch reports a good signature. If any signature is missing or invalid, stop and report it; do not push.

- [ ] **Step 8: Present the final human-visible diff before updating the draft PR**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: only scoped source, tests, generated assets, and the approved design documents are included; the diff check emits no errors. Summarize the behavior and verification results for the human partner before pushing unless they have already explicitly authorized the push for this implementation scope.
