# Semantic Review Map Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every behavioral change and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Replace the shallow, failure-prone review map with a progressive semantic review journey that opens instantly, organizes large diffs by behavior, and deterministically guarantees exact ownership of every changed line.

**Architecture:** Parse immutable diff change units first, compile an immediate deterministic provisional map, then run bounded semantic scouts, a global planner, and one critic repair pass. A deterministic compiler validates references, DAG order, split-file ranges, exact non-overlapping coverage, and quality thresholds before atomically publishing the semantic map. Map provenance remains independent from AI findings, and the renderer tracks review progress by semantic visit rather than by file.

**Tech Stack:** TypeScript ESM, Node.js 22, Pi coding-agent/model APIs, Glimpse native host, Monaco diff editor, Tailwind CSS, Node test runner via `tsx --test`, `tsgo` type checking.

---

## Implementation Boundaries

### New modules

- `src/review-change-units.ts`: canonical patch-to-unit extraction and optional child subdivision validation.
- `src/provisional-review-map.ts`: deterministic instant map compiler.
- `src/review-map-scout.ts`: bounded scout grouping, model requests, fact validation, and cache keys.
- `src/review-map-planner.ts`: global story/chapter proposal contract and normalization.
- `src/review-map-compiler.ts`: critic integration, repair, exact coverage, DAG, thresholds, and final compilation.
- `src/review-map-runner.ts`: progressive orchestration and host callbacks.
- `web/review-visit-state.js`: pure visit navigation, progress, and semantic-map reconciliation helpers.

### Modified modules

- `src/types.ts`: versioned map, units, visits, facts, progress, and host messages.
- `src/sources/types.ts`: commit evidence needed by mapping.
- `src/git.ts` and `src/file-patch.ts`: expose canonical patch/hunk metadata without reparsing command output ad hoc.
- `src/analysis.ts`: retain findings/approval compatibility while removing map generation responsibility.
- `src/ai-review-config.ts`: add separately configurable map scout/planner/critic routes and limits.
- `src/session-store.ts`: strict map v2 persistence and safe stale-state reconciliation.
- `src/renderer-protocol.ts`, `src/review-window.ts`, `src/index.ts`: authenticated progressive map delivery.
- `web/app.js`: provisional/semantic rendering, chapter briefs, visits, and preserved navigation.
- `README.md`: configuration and lifecycle documentation.

### Test fixtures

- `tests/fixtures/review-maps/pr-664/`: sanitized PR metadata, commits, canonical changed ranges, bounded patches, and expected structural assertions.
- `tests/fixtures/review-maps/corpus/`: schema, API, deletion-heavy, frontend, small-fix, and cross-cutting cases.

---

## Task 1: Introduce the Versioned Review Map Contract

**Files:**
- Modify: `src/types.ts`
- Modify: `src/sources/types.ts`
- Modify: `tests/session-store.test.ts`
- Modify: `tests/analysis.test.ts`

**Step 1: Write failing contract and persistence tests**

Add tests proving that:

- a v2 map with story, units, visits, exact coverage, status, fingerprint, and diagnostics survives save/load;
- unknown map versions and dangling visit/unit references are rejected;
- map status is distinct from `ReviewAnalysis.status` and AI review status;
- one file may occur in multiple chapters when visits reference disjoint units.

Use a minimal fixture builder:

```ts
function semanticMap(overrides: Partial<ReviewMap> = {}): ReviewMap {
  return {
    version: 2,
    status: "semantic",
    sourceFingerprint: "sha256:fixture",
    strategyVersion: "semantic-map-v1",
    story: {
      intent: "Move tool execution behind an async session runtime.",
      behaviorBefore: "Callers owned synchronous tool lifecycles.",
      behaviorAfter: "The session runtime owns async execution and cleanup.",
      primaryFlows: ["contract -> runtime -> caller -> verification"],
      removedOrReplacedBehavior: ["continuation-token dispatch"],
    },
    changeUnits: [unit("runtime-contract")],
    chapters: [chapterWithVisit("runtime-contract")],
    coverage: exactCoverage(1, 0),
    diagnostics: [],
    ...overrides,
  };
}
```

**Step 2: Run the focused tests and observe failure**

Run:

```bash
npm test -- --test-name-pattern='v2 map|split-file map|map version'
```

Expected: compile failures because `ReviewMap`, `ReviewVisit`, and exact map coverage do not exist.

**Step 3: Add the contract**

Add the spec types, including:

```ts
export type ReviewMapStatus = "provisional" | "mapping" | "semantic" | "semantic-repaired" | "fallback";
export type ReviewVisitRole = "start-here" | "contract" | "implementation" | "caller" | "integration" | "removed-path" | "verification" | "reference";

export interface ReviewVisit {
  id: string;
  fileId: string;
  changeUnitIds: string[];
  role: ReviewVisitRole;
  reason: string;
  focus: string[];
}

export interface ReviewMap {
  version: 2;
  status: ReviewMapStatus;
  sourceFingerprint: string;
  strategyVersion: string;
  story: ReviewChangeStory;
  changeUnits: ReviewChangeUnit[];
  chapters: ReviewChapter[];
  coverage: ExactCoverage;
  diagnostics: string[];
}
```

Place `map: ReviewMap` beside findings and approval state rather than encoding map provenance in `ReviewAnalysis.status`. Temporarily retain compatibility fields only where existing callers need them; mark their removal in a later task, not with TODO comments.

Extend `ReviewCommit` with deterministic evidence fields needed by the mapper, such as parent count, authored order, and touched file IDs. Populate them in source adapters in Task 3.

**Step 4: Make strict session decoding understand v2**

Do not accept maps with invented file IDs, repeated unit IDs, repeated visit IDs, out-of-order chapters, or references outside the persisted map. Keep range-level coverage validation in the compiler; persistence validates shape and referential integrity.

**Step 5: Run tests and type checking**

```bash
npm test -- --test-name-pattern='v2 map|split-file map|map version'
npm run check
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/types.ts src/sources/types.ts tests/session-store.test.ts tests/analysis.test.ts
git commit -m "feat: add semantic review map contract"
```

---

## Task 2: Extract Stable, Exact Change Units

**Files:**
- Create: `src/review-change-units.ts`
- Create: `tests/review-change-units.test.ts`
- Modify: `src/file-patch.ts`
- Modify: `src/git.ts`

**Step 1: Write extraction tests first**

Cover added, deleted, modified, renamed, replacement hunks, no-newline markers, and a large hunk. Assert:

- original and modified changed lines are represented exactly once;
- replacement sides remain in one parent unit;
- IDs are stable for identical fingerprint/path/ranges/patch and change when content changes;
- unchanged context does not count as owned coverage;
- malformed canonical metadata fails closed.

```ts
const result = extractReviewChangeUnits({
  sourceFingerprint: "sha256:a",
  file,
  patch: fixturePatch,
  commitIds: ["c1"],
});
assert.deepEqual(expandOwnedLines(result.units), {
  original: [10, 11],
  modified: [10, 11, 12],
});
```

Add subdivision tests proving exact-union acceptance and rejection for overlap, gaps, and out-of-parent ranges.

**Step 2: Run and observe the missing module failure**

```bash
npx tsx --test tests/review-change-units.test.ts
```

Expected: FAIL because the extractor is absent.

**Step 3: Expose canonical hunk data**

Extend the existing patch parser rather than adding a second regex parser. Return bounded hunk text, old/new changed ranges, header, and optional symbol hint. Preserve `git.ts` consistency checks between numstat and patch anchors.

**Step 4: Implement extraction and subdivision validation**

Use SHA-256 over canonical JSON fields:

```ts
function unitId(input: StableUnitIdentity): string {
  return `unit-${createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 20)}`;
}
```

The extractor owns deterministic facts only. Do not infer semantic chapter names here.

**Step 5: Verify**

```bash
npx tsx --test tests/review-change-units.test.ts
npm run check
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/review-change-units.ts src/file-patch.ts src/git.ts tests/review-change-units.test.ts
git commit -m "feat: extract exact review change units"
```

---

## Task 3: Build an Immediate Deterministic Provisional Map

**Files:**
- Create: `src/provisional-review-map.ts`
- Create: `tests/provisional-review-map.test.ts`
- Modify: `src/sources/github-pr.ts`
- Modify: `src/sources/local-working-tree.ts`
- Modify: `src/sources/types.ts`
- Modify: `src/index.ts`

**Step 1: Write behavior tests**

Fixtures should show that the provisional compiler:

- groups source and matching tests together instead of one giant Tests chapter;
- uses ordered commit-to-file incidence to separate unrelated flows;
- distinguishes deletion/removal work from additions;
- emits every unit exactly once;
- appends a supporting chapter only for leftovers;
- labels itself `provisional`, never `semantic`.

Include a 63-file PR-shaped fixture that fails if it collapses into `Service behavior / Tests / Miscellaneous`.

**Step 2: Run the new tests**

```bash
npx tsx --test tests/provisional-review-map.test.ts
```

Expected: FAIL because the compiler does not exist.

**Step 3: Populate commit evidence**

For GitHub PRs, order non-merge commits merge-base to head and attach touched focused-file IDs. Keep merge commits for provenance with `parentCount > 1`. Local sources may provide an empty commit graph; the compiler must still work from paths, names, statuses, and unit ranges.

**Step 4: Implement deterministic clustering**

Use weighted relationships, not a single path switch:

```ts
score(a, b) =
  commitIncidence(a, b) * 4 +
  sourceTestPair(a, b) * 4 +
  sharedPathPrefix(a, b) * 1 +
  changedSymbolAffinity(a, b) * 2;
```

Generate concise provisional titles from stable path/symbol tokens. Keep strategy version explicit so sessions invalidate when heuristics change.

**Step 5: Wire it before window creation**

After fingerprinting and unit extraction, compile the provisional map synchronously from local metadata and pass it in bootstrap data. Do not start semantic model work yet.

**Step 6: Verify and commit**

```bash
npx tsx --test tests/provisional-review-map.test.ts tests/sources.test.ts
npm run check
git add src/provisional-review-map.ts src/sources src/index.ts tests/provisional-review-map.test.ts
git commit -m "feat: compile instant provisional review maps"
```

---

## Task 4: Separate Map Provenance From Findings Analysis

**Files:**
- Modify: `src/analysis.ts`
- Modify: `src/ai-review.ts`
- Modify: `src/types.ts`
- Modify: `src/session-store.ts`
- Modify: `tests/analysis.test.ts`
- Modify: `tests/ai-review.test.ts`
- Modify: `tests/session-store.test.ts`

**Step 1: Add regression tests**

Prove that:

- completing AI findings review cannot change `map.status`;
- a fallback/provisional map remains visibly fallback/provisional after findings complete;
- findings can be merged into an analysis that owns no chapter generation;
- stale reconciliation clears generated findings and semantic maps appropriately while retaining a newly compiled provisional map.

**Step 2: Run focused tests and confirm failure**

```bash
npm test -- --test-name-pattern='map provenance|AI review cannot|provisional map'
```

Expected: FAIL because current AI review overwrites analysis status/message.

**Step 3: Refactor ownership**

Make `ReviewWindowData.map` host-owned. Restrict `ReviewAnalysis` to findings, coverage relevant to finding locations, and approval synthesis. Remove chapter generation from the AI-review result merge path.

Replace broad object spreads with explicit merges:

```ts
return {
  ...state,
  analysis: mergeFindings(state.analysis, result),
  map: state.map,
};
```

**Step 4: Preserve backward compatibility at the storage boundary**

Migrate valid legacy chapter data to a fallback v2 map once. Never infer `semantic` from legacy `ready`. Invalid legacy maps trigger deterministic provisional recompilation.

**Step 5: Verify and commit**

```bash
npx tsx --test tests/analysis.test.ts tests/ai-review.test.ts tests/session-store.test.ts
npm run check
git add src/analysis.ts src/ai-review.ts src/types.ts src/session-store.ts tests
git commit -m "refactor: separate review maps from findings"
```

---

## Task 5: Add Map Model Routing and Shared Structured Completion

**Files:**
- Create: `src/structured-model-completion.ts`
- Modify: `src/ai-review.ts`
- Modify: `src/ai-review-config.ts`
- Modify: `src/types.ts`
- Modify: `tests/ai-review-config.test.ts`
- Create: `tests/structured-model-completion.test.ts`

**Step 1: Write configuration tests**

Add `map.scout`, `map.planner`, and `map.critic` route tests for defaults, explicit model/reasoning overrides, unavailable model fallback, and bounded limits.

Expected standard defaults:

```ts
map: {
  scout: { model: "openai-codex/gpt-5.6-luna", reasoning: "medium" },
  planner: { model: "openai-codex/gpt-5.6-terra", reasoning: "high" },
  critic: { model: "openai-codex/gpt-5.6-sol", reasoning: "xhigh" },
}
```

Use capability-based fallback through the same resolver as AI review; do not assume every configured model is installed.

**Step 2: Extract structured completion behind tests**

Move JSON completion, abort propagation, response-size checks, and parse diagnostics from `ai-review.ts` into a shared helper. Preserve existing AI review behavior exactly.

**Step 3: Run tests**

```bash
npx tsx --test tests/ai-review-config.test.ts tests/structured-model-completion.test.ts tests/ai-review.test.ts
```

Expected: PASS after extraction.

**Step 4: Document configuration shape in code-level examples**

Support both user and repository config files already used by the app:

```json
{
  "aiReview": {
    "map": {
      "scout": { "model": "openai-codex/gpt-5.6-luna", "reasoning": "medium" },
      "planner": { "model": "openai-codex/gpt-5.6-terra", "reasoning": "high" },
      "critic": { "model": "openai-codex/gpt-5.6-sol", "reasoning": "xhigh" }
    }
  }
}
```

**Step 5: Verify and commit**

```bash
npm run check
git add src/structured-model-completion.ts src/ai-review.ts src/ai-review-config.ts src/types.ts tests
git commit -m "feat: configure semantic map model phases"
```

---

## Task 6: Implement Bounded Semantic Scouts

**Files:**
- Create: `src/review-map-scout.ts`
- Create: `tests/review-map-scout.test.ts`
- Modify: `src/types.ts`
- Modify: `src/session-store.ts`

**Step 1: Write scout tests with a fake model**

Assert that scouts:

- receive PR intent, bounded unit patches, symbols, commit evidence, and likely test pairs;
- return facts only, never chapters or findings;
- validate all referenced unit IDs;
- run with configured concurrency;
- reuse completed facts keyed by fingerprint + unit IDs + strategy version;
- continue with diagnostics when one scout fails;
- never exceed per-group input limits.

```ts
assert.deepEqual(result.facts[0].changedContracts, ["Tool calls become awaitable session operations"]);
assert.equal(result.facts[0].candidateRelationships[0].toUnitId, "unit-runtime");
```

**Step 2: Run and observe failure**

```bash
npx tsx --test tests/review-map-scout.test.ts
```

**Step 3: Implement grouping and fact validation**

Group by weighted unit relationships with deterministic chunking. Scouts may request a bounded nearby-context callback; enforce path, byte, and call-count limits in host code.

Reject output containing invented units. Sanitize prose lengths and cap relationship counts. Persist only validated facts.

**Step 4: Verify and commit**

```bash
npx tsx --test tests/review-map-scout.test.ts tests/session-store.test.ts
npm run check
git add src/review-map-scout.ts src/types.ts src/session-store.ts tests/review-map-scout.test.ts
git commit -m "feat: scout semantic change facts in parallel"
```

---

## Task 7: Implement the Review-Journey Planner

**Files:**
- Create: `src/review-map-planner.ts`
- Create: `tests/review-map-planner.test.ts`
- Modify: `src/types.ts`

**Step 1: Write planner contract tests**

Test normalization and rejection for:

- missing global before/after story;
- generic directory-mirror chapter titles;
- missing objective, rationale, questions, entry visit, or exit criteria;
- invented units/files;
- duplicate unit assignment;
- split-file child proposals that do not preserve parent ranges;
- GitHub comments treated as signals, not findings or forced ownership.

Use a PR #664-shaped fact fixture and assert the proposed journey contains independent async contracts, runtime ownership, integration, removal, lifecycle, and evidence flows.

**Step 2: Run the test and observe failure**

```bash
npx tsx --test tests/review-map-planner.test.ts
```

**Step 3: Implement prompt assembly and strict normalization**

The planner input must include:

- PR title/body;
- ordered commit subjects and unit incidence;
- unit inventory with bounded patch summaries;
- validated scout facts;
- matching cached GitHub discussion context, or a bounded wait result;
- repository guidance excerpts already available to the host.

The planner returns a proposal, not a trusted map. Preserve raw diagnostics but never render unvalidated output.

**Step 4: Verify and commit**

```bash
npx tsx --test tests/review-map-planner.test.ts
npm run check
git add src/review-map-planner.ts src/types.ts tests/review-map-planner.test.ts
git commit -m "feat: plan semantic review journeys"
```

---

## Task 8: Compile, Critique, Repair, and Prove Exact Coverage

**Files:**
- Create: `src/review-map-compiler.ts`
- Create: `tests/review-map-compiler.test.ts`
- Modify: `src/review-map-planner.ts`
- Modify: `src/types.ts`

**Step 1: Write deterministic compiler tests**

Cover:

- exact original/modified changed-line coverage;
- overlap and gap rejection;
- legal split-file assignments across chapters;
- illegal child subdivisions;
- DAG validation and deterministic review order;
- derived file lists, diffstats, weights, and visit totals;
- supporting share threshold of at most 20% of units and 20% of changed-line weight unless a specific diagnostic exception is present;
- no standalone bulk Tests bucket when test units pair with behavior;
- one bounded critic repair pass;
- fallback status and diagnostics after failed repair.

```ts
const compiled = compileReviewMap({ proposal, units, canonicalCoverage });
assert.equal(compiled.coverage.unmappedModifiedLineCount, 0);
assert.equal(compiled.coverage.overlappingModifiedLineCount, 0);
assert.deepEqual(compiled.chapters.flatMap(chapter => chapter.visits.flatMap(v => v.changeUnitIds)).sort(), unitIds.sort());
```

**Step 2: Run and observe failure**

```bash
npx tsx --test tests/review-map-compiler.test.ts
```

**Step 3: Implement pure validation before critic orchestration**

Keep the compiler pure and independently testable. The critic receives proposal plus deterministic diagnostics and returns either `accept` or a constrained repair request. The planner gets exactly one repair call in v0.

Never silently patch an invalid semantic proposal into `semantic`. Only deterministic leftover units may be placed in Supporting; quality-gate breaches require repair or explicit fallback.

**Step 4: Verify and commit**

```bash
npx tsx --test tests/review-map-compiler.test.ts tests/review-map-planner.test.ts
npm run check
git add src/review-map-compiler.ts src/review-map-planner.ts src/types.ts tests
git commit -m "feat: validate and repair semantic review maps"
```

---

## Task 9: Orchestrate Progressive Map Generation

**Files:**
- Create: `src/review-map-runner.ts`
- Create: `tests/review-map-runner.test.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Modify: `src/renderer-protocol.ts`
- Modify: `src/review-window.ts`
- Modify: `tests/renderer-protocol.test.ts`
- Modify: `tests/review-window.test.ts`

**Step 1: Write orchestration and protocol tests**

Prove this sequence:

1. window bootstraps with usable provisional map;
2. authenticated `review-map-progress` reports mapping/scout/planner/critic phases;
3. only a validated final map arrives in `review-map-result`;
4. stale request IDs, capabilities, or fingerprints are ignored;
5. partial scout facts never mutate the renderer map;
6. cancellation on window close stops model work without corrupting the saved provisional map;
7. cached semantic maps skip repeated model work when fingerprint and strategy match.

**Step 2: Run focused tests**

```bash
npx tsx --test tests/review-map-runner.test.ts tests/renderer-protocol.test.ts tests/review-window.test.ts
```

Expected: FAIL until new host messages exist.

**Step 3: Implement the runner**

```ts
await runSemanticReviewMap({
  dataset,
  units,
  provisionalMap,
  config,
  signal,
  onProgress,
  onValidatedMap,
});
```

Start it after the renderer is usable. GitHub context uses matching cache immediately, waits for an in-flight refresh only up to a configured bound, then proceeds without it.

Persist the final validated map before notifying the renderer so restart cannot regress to a UI-only semantic state.

**Step 4: Verify and commit**

```bash
npx tsx --test tests/review-map-runner.test.ts tests/renderer-protocol.test.ts tests/review-window.test.ts
npm run check
git add src/review-map-runner.ts src/index.ts src/types.ts src/renderer-protocol.ts src/review-window.ts tests
git commit -m "feat: stream validated review maps to the cockpit"
```

---

## Task 10: Add Visit-Based Progress and Atomic Map Reconciliation

**Files:**
- Create: `web/review-visit-state.js`
- Create: `tests/review-visit-state.test.ts`
- Modify: `web/app.js`
- Modify: `src/types.ts`
- Modify: `src/session-store.ts`
- Modify: `src/renderer-protocol.ts`

**Step 1: Write pure state tests**

Cover:

- next/previous visit order across chapters;
- completing one visit does not complete another visit in the same file;
- a file becomes globally complete only when every visit is complete;
- semantic-map replacement preserves active file, matching unit/hunk, scroll anchor, expanded chapters, comments, findings, and completed progress;
- provisional completion maps to semantic visits by exact unit identity;
- unmatched progress remains visible in diagnostics rather than being guessed;
- clicking a chapter does not select its first file.

**Step 2: Run and observe failure**

```bash
npx tsx --test tests/review-visit-state.test.ts
```

**Step 3: Implement pure helpers and then integrate**

Keep DOM code thin:

```js
export function reconcileReviewMapState(previousMap, nextMap, uiState) { /* pure */ }
export function nextReviewVisit(map, progress, activeVisitId, direction = 1) { /* pure */ }
export function completeVisit(progress, visitId) { /* pure */ }
```

Store `reviewedVisits` in session snapshots. Migrate legacy reviewed-file state by marking visits complete only when all their units belonged solely to that reviewed file; otherwise preserve the file state as a visible migration diagnostic.

**Step 4: Verify and commit**

```bash
npx tsx --test tests/review-visit-state.test.ts tests/session-store.test.ts tests/renderer-protocol.test.ts
npm run check
git add web/review-visit-state.js web/app.js src/types.ts src/session-store.ts src/renderer-protocol.ts tests
git commit -m "feat: track semantic review visits"
```

---

## Task 11: Render the Human Review Journey

**Files:**
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `tests/smoke.test.ts`
- Create: `tests/review-map-ui.test.ts`

**Step 1: Add UI behavior tests**

Assert that:

- the sidebar remains compact: title, order, progress, review-first cue, findings count;
- `Preparing review plan` and semantic/fallback provenance are truthful and distinct from findings scan status;
- chapter brief shows behavior change, why it matters, review questions, ordered visits, evidence, gaps, and exit criteria;
- `Start review` opens the start-here visit;
- sticky file header shows chapter, visit number, role, and file path;
- `Space` completes the current visit, `]`/`[` changes visit, and `j`/`k` navigates relevant hunks/findings without intercepting text input;
- a split file opens at the correct chapter-owned ranges;
- semantic upgrade causes no active-file or scroll jump.

**Step 2: Implement the concise UI**

Do not add a new panel or map-management dashboard. Chapter detail replaces the center canvas only when a chapter is selected. File visits open the existing diff canvas.

Display evidence honestly:

- `Proves`: linked test visits and stated behavior;
- `Does not prove`: explicit gaps from scouts/planner;
- no green assurance merely because tests exist.

For a file shared across chapters, visually emphasize the active visit's owned ranges while keeping surrounding diff context readable.

**Step 3: Build and run UI tests**

```bash
npm run build:web
npx tsx --test tests/review-map-ui.test.ts tests/smoke.test.ts
npm run check
```

Expected: PASS, with generated web bundle updated only by the normal build command.

**Step 4: Commit**

```bash
git add web tests/review-map-ui.test.ts
git commit -m "feat: render semantic review journeys"
```

---

## Task 12: Add PR #664 and Golden-Corpus Acceptance Gates

**Files:**
- Create: `tests/fixtures/review-maps/pr-664/metadata.json`
- Create: `tests/fixtures/review-maps/pr-664/commits.json`
- Create: `tests/fixtures/review-maps/pr-664/units.json`
- Create: `tests/fixtures/review-maps/pr-664/scout-facts.json`
- Create: `tests/fixtures/review-maps/pr-664/planner-proposal.json`
- Create: `tests/fixtures/review-maps/corpus/*.json`
- Create: `tests/review-map-acceptance.test.ts`
- Modify: `README.md`

**Step 1: Sanitize and pin deterministic fixture inputs**

Do not record secrets, full repository files, or mutable live GitHub responses. Store bounded changed-unit excerpts and metadata sufficient to reproduce structural compilation.

**Step 2: Add PR #664 structural assertions**

The test must reject the known bad output and require between 7 and 9 coherent flows covering:

1. async tool contracts and lifecycle;
2. session runtime and resource ownership;
3. turn tracing and LangGraph bridge;
4. web and placard execution;
5. routing and continuation removal;
6. worker shutdown and cancellation;
7. end-to-end regression evidence;
8. supporting docs/scripts when present.

Avoid exact prose snapshots. Assert objectives, roles, ownership, dependency ordering, paired evidence, supporting thresholds, and exact coverage.

**Step 3: Add the smaller corpus**

Each fixture asserts its important invariant:

- schema: migration order, rollback questions, models/tests paired;
- API: contract, implementation, caller, auth/error evidence;
- deletion-heavy: removed behavior and surviving callers;
- frontend: state/data flow and interaction tests;
- small fix: no unnecessary chapter inflation;
- cross-cutting: split-file visits and dependency DAG.

**Step 4: Document the workflow**

Update README with:

- instant provisional then semantic upgrade lifecycle;
- map status meanings;
- config routes and defaults;
- cache/invalidation behavior;
- visit-based progress and split-file semantics;
- fallback diagnostics and reset behavior.

**Step 5: Run the full verification suite**

```bash
npm test
npm run check
npm run build:web
git diff --check
```

Expected: all commands PASS and the worktree contains no unexpected generated files.

**Step 6: Commit**

```bash
git add tests/fixtures/review-maps tests/review-map-acceptance.test.ts README.md web
git commit -m "test: gate semantic review map quality"
```

---

## Task 13: Final Product and Reliability Verification

**Files:**
- Modify only files required by discovered defects.

**Step 1: Run a clean PR #664 review session**

Use the CLI reset flag for PR #664, then verify manually:

- raw diff and provisional navigation appear before model completion;
- map status progresses truthfully;
- semantic chapters replace provisional chapters without moving the active code line;
- no generic 30-file Tests or 32-file Miscellaneous bucket appears;
- implementation and tests are paired by behavior;
- split-file visits open at their owned ranges;
- every visit can be completed by keyboard;
- closing and reopening restores map and visit progress;
- unchanged fingerprint causes no repeated semantic work;
- a changed PR head invalidates generated map/facts while preserving only safely reconcilable human state.

Record timings for bootstrap, provisional map, scouts, planner, critic, and final map in test notes; do not expose agent-management detail in primary UI.

**Step 2: Inspect the persisted artifact**

Validate referential integrity and independently expand all canonical changed lines against compiled ownership. Confirm zero gaps and zero overlaps.

**Step 3: Run adversarial review**

Use `superpowers:requesting-code-review` and review specifically for:

- invented semantic confidence;
- hidden fallback state;
- model output trusted before deterministic validation;
- stale async results mutating a newer fingerprint;
- session migration data loss;
- oversized prompts or unbounded context callbacks;
- keyboard regressions and visual reflow.

**Step 4: Apply only evidence-backed fixes and rerun verification**

```bash
npm test
npm run check
npm run build:web
git diff --check
git status --short
```

**Step 5: Commit final fixes if any**

Stage only the files changed for verified defects, inspect `git diff --cached`, then commit them:

```bash
git commit -m "fix: harden semantic review map workflow"
```

---

## Completion Criteria

- The diff is interactive before semantic map generation finishes.
- Map provenance cannot be overwritten by findings review.
- Every changed original and modified line has exactly one semantic owner.
- Different ranges in one file can belong to different chapters without duplicate progress.
- Chapters form a useful dependency-ordered human review journey with objectives, questions, evidence, gaps, and exit criteria.
- PR #664 cannot regress to the known shallow three-bucket map.
- Failed semantic planning is explicit, deterministic, and recoverable.
- Matching sessions avoid repeated model work; changed fingerprints invalidate generated artifacts safely.
- Full tests, type checks, web build, and manual PR #664 verification pass.
