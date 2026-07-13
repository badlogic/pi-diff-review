# Inline Review Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every inline review item expanded by default and give AI, human, and published items an unmistakable per-item disclosure control.

**Architecture:** Add a small pure helper for explicit-collapse state and use it for both AI finding IDs and comment IDs. Keep review status, dismissal, and persistence behavior unchanged; Monaco decorations derive visual state from the helper and the AI card exposes the same toggle in its header.

**Tech Stack:** JavaScript ES modules, Monaco Editor decorations and view zones, Tailwind-generated CSS, Node test runner with `tsx`.

---

### Task 1: Explicit-Collapse State

**Files:**
- Create: `web/review-disclosure-state.js`
- Create: `tests/review-disclosure-state.test.ts`
- Modify: `web/app.js:240-246,1648-1694,1718-1725,2208-2219,2860-2890,2977-2989,3640-3655`

- [ ] **Step 1: Write the failing state tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { collapseDisclosure, expandDisclosure, isDisclosureExpanded, toggleDisclosure } from "../web/review-disclosure-state.js";

test("review disclosures are expanded until explicitly collapsed", () => {
  const collapsed = new Set<string>();
  assert.equal(isDisclosureExpanded(collapsed, "finding-1"), true);
  collapseDisclosure(collapsed, "finding-1");
  assert.equal(isDisclosureExpanded(collapsed, "finding-1"), false);
});

test("review disclosures toggle independently and can be reopened by navigation", () => {
  const collapsed = new Set(["finding-1", "finding-2"]);
  toggleDisclosure(collapsed, "finding-1");
  assert.deepEqual([...collapsed], ["finding-2"]);
  expandDisclosure(collapsed, "finding-2");
  assert.equal(collapsed.size, 0);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test tests/review-disclosure-state.test.ts`

Expected: FAIL because `web/review-disclosure-state.js` does not exist.

- [ ] **Step 3: Implement the state helper**

```js
export function isDisclosureExpanded(collapsedIds, id) {
  return !collapsedIds.has(id);
}

export function collapseDisclosure(collapsedIds, id) {
  collapsedIds.add(id);
}

export function expandDisclosure(collapsedIds, id) {
  collapsedIds.delete(id);
}

export function toggleDisclosure(collapsedIds, id) {
  if (isDisclosureExpanded(collapsedIds, id)) collapseDisclosure(collapsedIds, id);
  else expandDisclosure(collapsedIds, id);
}
```

- [ ] **Step 4: Replace opt-in finding expansion with explicit collapse**

Import the helper in `web/app.js`, replace `expandedFindingIds` with `collapsedFindingIds`, and make `isAiFindingExpanded()` require a new finding whose ID is not collapsed. Use `toggleDisclosure()` for gutter clicks and `expandDisclosure()` when navigation intentionally opens a finding. Keep comment disclosures default-open by applying the same helper to `collapsedCommentIds`.

- [ ] **Step 5: Run focused tests and type checking**

Run: `npx tsx --test tests/review-disclosure-state.test.ts && npm run check`

Expected: both commands PASS.

### Task 2: Disclosure Affordance

**Files:**
- Modify: `web/app.js:2580-2640,2916-2950,3040-3080`
- Modify: `web/review.css:105-190`
- Modify: `tests/smoke.test.ts:95-116,185-202`

- [ ] **Step 1: Write failing smoke expectations**

Require `web/app.js` and `web/review.css` to contain:

```ts
assert.equal(appJs.includes("review-disclosure-expanded"), true);
assert.equal(appJs.includes("review-disclosure-collapsed"), true);
assert.equal(appJs.includes("Collapse AI review"), true);
assert.equal(appJs.includes("Expand AI review"), true);
assert.equal(appJs.includes('data-action="collapse-finding"'), true);
assert.equal(css.includes('content: "⌄"'), true);
assert.equal(css.includes('content: "›"'), true);
assert.equal(css.includes('content: "✦"'), false);
```

- [ ] **Step 2: Run smoke tests and verify RED**

Run: `npx tsx --test tests/smoke.test.ts`

Expected: FAIL because the current marker is a sparkle and the card has no collapse control.

- [ ] **Step 3: Render disclosure state and actionable tooltips**

Return gutter class names containing `review-disclosure-expanded` or `review-disclosure-collapsed`. Update hover messages to say `Collapse` or `Expand` and retain AI, reviewer, or published provenance in the message.

- [ ] **Step 4: Add the AI card header control**

Add a compact header button with `data-action="collapse-finding"`, `aria-label="Collapse AI review"`, and `title="Collapse AI review"`. Its click handler toggles only that finding, refreshes zones and decorations, and stops propagation so it cannot change unrelated state.

- [ ] **Step 5: Replace status symbols with chevrons**

Style disclosure controls as 16px rounded-square buttons aligned to the Monaco gutter. Use `⌄` for expanded and `›` for collapsed, with violet, blue, and gray variants inherited from the existing provenance classes. Preserve visible hover/focus contrast without increasing the gutter footprint.

- [ ] **Step 6: Run focused and complete verification**

Run:

```bash
npx tsx --test tests/review-disclosure-state.test.ts tests/smoke.test.ts
npm run check
npm test
npm run build:web
git diff --check
```

Expected: all tests and builds PASS with no whitespace errors.
