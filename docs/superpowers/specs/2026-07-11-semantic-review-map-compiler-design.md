# Semantic Review Map Compiler Design

## Problem

The current review-map generator is not reliable or useful enough for large pull requests. It makes one model call with PR metadata, file paths, diff status, line counts, and changed ranges. It does not provide patch content, changed symbols, commit intent, callers, dependencies, removed behavior, or implementation-to-test relationships. The same response must also produce findings and an approval packet under a large strict JSON contract.

When that call fails, the cockpit silently uses path rules:

- paths containing `/services/` become `Service behavior`;
- test paths become `Tests`;
- most other paths become `Miscellaneous changes`.

The later AI review can overwrite the fallback status with `ready`, hiding that degradation. For `headout/magellan#664`, this produced three areas for 63 files and 7,218 changed lines: one deleted service file, 30 test files, and 32 miscellaneous files. The map contains no useful representation of the async-tool architecture, runtime ownership, LangGraph integration, cancellation, route migration, or removed continuation machinery.

The review map must instead help a human establish the change story, follow runtime behavior in dependency order, verify invariants, connect implementation to evidence, and complete the review without repeatedly reconstructing context.

## Goals

1. Open the raw diff immediately; AI map generation must never block human review.
2. Organize changes as end-to-end review stories rather than directories or file types.
3. Give each chapter a deliberate reading order, concrete reviewer questions, and paired evidence.
4. Allow different changed regions of one file to belong to different chapters.
5. Guarantee exact, non-overlapping ownership of every changed line.
6. Preserve active navigation and human progress when a semantic map replaces the provisional map.
7. Make degraded map quality explicit and recoverable.
8. Keep map planning separate from findings generation and verdict synthesis.

## Non-Goals

- The map generator does not discover or publish review findings.
- It does not infer correctness merely from test presence.
- It does not hide unchanged source context that a reviewer chooses to inspect.
- It does not require a language-specific parser for every repository language in the first implementation.
- It does not use commit boundaries as authoritative review chapters.

## Product Principles

### Review stories, not file buckets

A chapter represents one coherent behavioral or architectural question. It may contain contracts, implementation, callers, removed paths, and tests from different directories. Tests normally travel with the behavior they prove. A separate test chapter is reserved for cross-cutting integration evidence.

### Reviewer sequence, not taxonomy

The order should minimize unresolved context. Contracts and invariants precede implementations; implementations precede callers and integrations; focused evidence follows the behavior it verifies. Supporting changes come last.

### AI proposes; deterministic code guarantees

Models may summarize and organize change units. Deterministic code owns diff parsing, stable identities, range validation, coverage, overlap rejection, progress reconciliation, and fallback behavior.

### Progressive enrichment without disruption

The diff and provisional navigation are usable immediately. The semantic map replaces the provisional map only after validation, and the replacement preserves the active file, active hunk, scroll position, disclosure state, comments, findings, and completed progress.

## Architecture

### Phase 0: Instant provisional map

Build a deterministic provisional map before opening the window from:

- changed files and statuses;
- canonical diffstats;
- commit-to-file incidence;
- test/source naming relationships;
- additions, deletions, renames, and removed files.

The provisional map is explicitly labeled `Preparing review plan`. It must be more useful than the current path fallback, but it is not presented as semantic analysis.

### Phase 1: Change-unit extraction

Convert the diff into stable change units. A unit is normally one logical hunk or a bounded contiguous portion of a large hunk. It contains:

- stable ID derived from the source fingerprint, file identity, ranges, and patch hash;
- file ID and canonical path;
- original and modified changed ranges;
- file status;
- hunk header and nearby symbol when available;
- bounded patch text;
- contributing commit IDs;
- likely test counterpart metadata.

Commit evidence is ordered from the merge base toward the reviewed head. Merge commits are retained for provenance but down-weighted as semantic intent; their constituent non-merge commits and final diff remain authoritative.

Original and modified ranges for a replacement normally remain in one unit. Unchanged context is explanatory and is not part of coverage ownership.

If one hunk contains multiple substantive concerns, the planner may propose child units. The deterministic compiler accepts a subdivision only when every child range lies within the parent changed ranges, children do not overlap, and their union exactly preserves the parent coverage. Child IDs are derived deterministically from the parent ID and ranges.

### Phase 2: Parallel semantic scouts

Run bounded scouts over related change-unit groups. Groups may use commit incidence, paths, imports visible in patches, symbol names, and test pairing, but no single grouping signal is authoritative.

Scouts return compact facts, not chapters or findings:

- behavioral intent;
- changed contracts and symbols;
- callers and dependencies;
- removed or replaced behavior;
- lifecycle and ownership changes;
- invariants a reviewer should verify;
- evidence supplied by tests;
- missing evidence or context;
- candidate relationships among change units;
- confidence and unresolved questions.

Scouts may request bounded nearby unchanged source context. Completed scout facts are cached by source fingerprint and change-unit ID so retries do not repeat successful work.

### Phase 3: Review-journey planner

The planner consumes:

- PR title and description;
- ordered commit subjects and commit-to-file incidence;
- change-unit inventory;
- scout facts;
- relevant existing GitHub review threads;
- repository guidance and changed architecture documentation when available.

It produces a global before/after change story and an ordered set of behavioral chapters. It assigns every change unit to one chapter and defines file visits inside each chapter.

Existing comments are attention signals only. They do not become findings, alter exact coverage, or force a chapter assignment.

GitHub context must not hold the planner indefinitely. The planner uses matching cached context immediately, waits only for a bounded in-flight refresh, and proceeds without comment signals when context is unavailable. A later context refresh enriches discussion links but does not silently reorganize a validated map.

### Phase 4: Adversarial map critic

The critic evaluates the proposed journey and either accepts it or returns a bounded repair request. It rejects:

- generic directory mirrors;
- oversized miscellaneous or test buckets;
- chapters without a start point or reviewer objective;
- implementation chapters with no evidence or explicit evidence gap;
- circular or incoherent dependencies;
- duplicated substantive chapters;
- large chapters containing independent behavioral flows;
- file ordering without role explanations;
- assignments unsupported by scout facts or patches.

The planner receives one repair pass in the initial implementation. A repaired plan is marked `semantic-repaired`.

### Phase 5: Deterministic compilation

The compiler:

1. validates every referenced chapter, visit, file, and change-unit ID;
2. compiles change-unit ownership into exact original and modified ranges;
3. rejects overlaps and out-of-diff ranges;
4. confirms exact coverage of all changed lines;
5. validates chapter dependencies as a directed acyclic graph;
6. derives file lists, diffstats, weights, and progress totals;
7. appends a final `Supporting or unclassified changes` chapter for any unassigned units;
8. invokes repair when the supporting share exceeds the quality threshold;
9. publishes the map atomically only after validation succeeds.

## Data Contract

### Map

```ts
type ReviewMapStatus =
  | "provisional"
  | "mapping"
  | "semantic"
  | "semantic-repaired"
  | "fallback";

interface ReviewMap {
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

Map status remains independent of AI finding-review status. Running or completing AI review cannot convert a fallback map into a semantic map.

### Global change story

```ts
interface ReviewChangeStory {
  intent: string;
  behaviorBefore: string;
  behaviorAfter: string;
  primaryFlows: string[];
  removedOrReplacedBehavior: string[];
}
```

### Change unit

```ts
interface ReviewChangeUnit {
  id: string;
  fileId: string;
  path: string;
  symbol?: string;
  ranges: ReviewChapterRange[];
  status: "added" | "modified" | "deleted" | "renamed";
  commitIds: string[];
}
```

### Chapter

```ts
interface ReviewChapter {
  id: string;
  title: string;
  objective: string;
  whyItMatters: string;
  reviewOrder: number;
  priority: ReviewChapterPriority;
  priorityReason: string;
  dependsOn: string[];
  reviewQuestions: string[];
  changeFlow: string[];
  visits: ReviewVisit[];
  testEvidence: TestEvidence[];
  exitCriteria: string[];
  attentionTags: string[];
  findingIds: string[];
}
```

### Visit and evidence

```ts
type ReviewVisitRole =
  | "start-here"
  | "contract"
  | "implementation"
  | "caller"
  | "integration"
  | "removed-path"
  | "verification"
  | "reference";

interface ReviewVisit {
  id: string;
  fileId: string;
  changeUnitIds: string[];
  role: ReviewVisitRole;
  reason: string;
  focus: string[];
}

interface TestEvidence {
  visitIds: string[];
  proves: string[];
  doesNotProve: string[];
}
```

`fileIds`, chapter ranges, diffstats, and review weights become compiler-derived compatibility fields rather than model-authored truth.

## Split-File Semantics

A file may appear in several chapters through different visits and non-overlapping change units. For example:

```text
agent_graph.py
├─ lines 214-260 -> Turn tracing and LangGraph bridge
├─ lines 480-522 -> Conversation routing migration
└─ lines 710-748 -> Runtime cancellation and cleanup
```

The rules are:

1. Every changed line has exactly one semantic owner.
2. Unchanged context may appear in multiple visits.
3. A visit may own several related units in one file.
4. Completing one visit does not complete other visits for the same file.
5. A file becomes globally reviewed only when every visit referencing it is complete.
6. Unassigned units remain visible in the final supporting chapter.

## Human Review Workflow

### Sidebar

The unified sidebar remains compact. Each chapter row shows only:

- review order and concise semantic title;
- completed visits over total visits;
- a `Review first` cue when applicable;
- open finding count.

Descriptions, file roles, and rationale stay out of the navigation tree.

### Chapter brief

The chapter brief answers:

1. What behavior changes?
2. Why should this area be reviewed now?
3. What questions must the reviewer answer?
4. What should be read first, and why?
5. Which tests prove the behavior, and what remains unproven?

It presents:

- before/after behavioral summary;
- objective and priority rationale;
- three to five review questions;
- ordered visits with roles, reasons, and focus points;
- concise behavioral flow;
- paired test evidence and explicit gaps;
- chapter dependencies;
- relevant existing GitHub discussion.

The primary action is `Start review`.

### Diff review

The sticky header identifies the chapter, visit position, role, and file. Opening a visit centers its first owned hunk. Chapter-owned changed areas receive a restrained gutter treatment; unrelated hunks remain available but can be muted under the existing changed-area control.

Keyboard behavior:

- `Space`: complete the current visit and advance;
- `]` / `[`: next or previous planned visit;
- `j` / `k`: move among relevant hunks and findings.

The repeated loop is: brief, inspect relevant code, verify invariant, inspect evidence, complete, advance.

## Progressive Upgrade And Progress Reconciliation

The renderer starts with the provisional map. While the semantic pipeline runs, it shows compact ambient progress such as `Mapping 19/63 files` without blocking navigation.

When a validated map arrives:

1. Anchor the active location by file ID and nearest stable change-unit range.
2. Reconcile completed provisional progress to semantic visits using stable change-unit IDs.
3. Preserve comments, findings, GitHub context, scroll position, and disclosure state.
4. Replace the navigation tree atomically.
5. Keep the active file and visible code stationary.

If reconciliation cannot identify a prior provisional unit exactly, keep it incomplete rather than guessing.

## Failure Handling

- Diff loading and manual review never depend on semantic generation.
- A failed semantic pass retains the deterministic provisional map as `fallback`.
- The UI shows one compact `Semantic plan unavailable` status and retry action.
- Full diagnostics remain local; renderer messages are bounded and sanitized.
- Successfully cached scout facts survive retry for the same fingerprint.
- A changed source fingerprint invalidates the semantic map, scout facts, and unit-level progress that cannot be reconciled.
- Human comments and safely remappable progress are preserved through the existing stale-session rules.
- No fallback map is presented as semantic or AI-complete.

## Quality Gates

A semantic map is accepted only when:

1. changed-line coverage is exactly 100% with no overlap;
2. every chapter has an objective, rationale, entry visit, review questions, and exit criteria;
3. dependencies form a directed acyclic graph;
4. source changes have paired evidence or an explicit gap;
5. split-file assignments use valid non-overlapping change units;
6. no chapter is merely a directory or file-type dump;
7. the supporting chapter owns at most 20% of change units and at most 20% of changed-line weight unless the critic provides a specific exception rationale;
8. independent flows are not hidden in one oversized chapter;
9. visit order and roles are supported by the supplied evidence.

Either 20% supporting threshold triggers a repair attempt. If repair still fails, the map remains usable but is marked `fallback`, not semantic.

## Model Routing And Configuration

Map generation uses the same dependency-free phase configuration pattern as AI review, but map phases remain distinct from finding-review phases:

- `map.scout`: parallel bounded semantic extraction;
- `map.planner`: high-reasoning journey synthesis;
- `map.critic`: false-positive-sensitive structural validation and repair.

The standard default should use a fast GPT-5.6 category model at medium reasoning for scouts, a stronger category model at high reasoning for planning, and the strongest available category model at high or xhigh reasoning for criticism. Exact model IDs follow the existing runtime capability resolution and fallback rules. Repository and user configuration may override each phase independently.

Composable skills may enrich scout and critic rubrics, but no skill can weaken deterministic coverage, provenance, or overlap validation. Model unavailability falls back to the provisional compiler without blocking the diff.

## PR #664 Acceptance Fixture

`headout/magellan#664` is the primary large-PR fixture. At the current reviewed head it contains 63 changed files, 4,560 additions, and 2,658 deletions.

A useful map should produce approximately these review stories:

1. Async tool contracts and lifecycle protocol.
2. Session-scoped runtime and resource ownership.
3. Turn tracing and LangGraph tool bridge.
4. Web and placard execution paths.
5. Conversation routing and continuation removal.
6. Worker lifecycle, shutdown, and cancellation.
7. End-to-end behavior and regression evidence.
8. Supporting scripts and documentation.

Acceptance expectations:

- approximately seven to nine coherent chapters;
- contracts precede implementations and callers;
- focused tests are paired with their behavior;
- cross-cutting integration tests are isolated as evidence;
- deleted continuation machinery belongs to the migration story;
- large files can contribute different units to different chapters;
- only genuinely incidental changes remain supporting;
- all 63 files and all changed-line coverage remain represented.

Exact chapter wording is not golden. Semantic coherence, ordering, evidence pairing, split-file correctness, and coverage are.

## Evaluation Corpus

Maintain fixtures for:

- a schema migration;
- an API feature;
- a deletion-heavy refactor;
- a frontend behavior change;
- a small focused bug fix;
- a large cross-cutting system change.

Automated assertions cover:

- exact coverage and overlap rejection;
- stable unit and visit identities;
- dependency validity;
- generic supporting share;
- implementation-to-test pairing;
- split-file assignment;
- deterministic fallback quality;
- progress reconciliation across provisional and semantic maps;
- preservation of map provenance after AI findings complete.

Human evaluation should measure whether reviewers can accurately explain the before/after behavior, locate the highest-value code first, and complete review with fewer file revisits and less navigation time than alphabetical or path-based grouping.

## Migration Strategy

1. Introduce the versioned map and change-unit contracts alongside the existing chapter fields.
2. Derive existing `fileIds`, ranges, weights, and diffstats from visits for renderer compatibility.
3. Separate map persistence and provenance from finding-review status.
4. Add the provisional compiler and open the window before semantic analysis.
5. Add scouts, planner, critic, deterministic compilation, and atomic renderer upgrade.
6. Migrate review progress from file booleans to visit IDs while retaining derived global file completion.
7. Remove the old path-only fallback after the stronger commit/file-graph fallback is covered by fixtures.

No previously saved semantic map is migrated across contract version 2. Existing comments and GitHub publication state remain governed by their current durable contracts.
