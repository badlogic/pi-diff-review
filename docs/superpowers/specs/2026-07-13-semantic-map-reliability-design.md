# Semantic Map Reliability Design

## Problem

The semantic review-map pipeline can degrade to a deterministic fallback even when the pull request is within the configured model-input limit and the model could produce a valid map after a small correction.

This happened repeatedly while testing `headout/magellan#669`:

1. A scout batch failed with `Scout metadata exceeds the configured input budget.` Its patch allocator counted raw patch characters, but the actual request was JSON. Escaped newlines, quotes, and backslashes made the serialized payload larger than the estimate. The batch was rejected after allocation instead of being resized or split.
2. The planner returned a chapter priority outside the parser's closed enum. The system prompt said that a priority was required, but did not list the allowed values. The runner parsed the first planner response before entering either of its existing repair paths, so this correctable contract error immediately forced the whole map to fallback.

The scout payload also repeats the full file patch for every change unit in that file, and the planner payload is not bounded. These amplify input size on large or escape-heavy diffs. Existing tests use small, simple patches and do not exercise these failure modes.

The system should continue to treat model output as untrusted. Reliability must come from bounded inputs, explicit contracts, limited repair, and deterministic validation rather than accepting malformed or incomplete maps.

## Goals

1. Keep every scout and planner request at or below its configured serialized-input limit.
2. Avoid repeating the same file patch within a scout request.
3. Preserve every change-unit identity needed for assignment while sending compact model-facing metadata.
4. Recover from correctable planner contract, critic, and compiler-quality failures with at most two additional planner calls.
5. Tolerate an isolated malformed scout response without restarting successful scout work.
6. Retain strict deterministic validation for IDs, roles, priorities, coverage, overlap, dependencies, and map quality.
7. Emit concise, stage-specific diagnostics that explain degradation without storing raw model output.
8. Prove the behavior with regression, boundary, and stress tests, then verify it end-to-end on `headout/magellan#669`.

## Non-Goals

- Guaranteeing that a model always returns a useful semantic interpretation.
- Retrying indefinitely or increasing model-call concurrency without a bound.
- Weakening the parser or compiler to coerce invalid priorities, roles, IDs, coverage, or dependency graphs.
- Replacing semantic grouping with deterministic path-based grouping.
- Changing the persisted review-map schema or the presentation-gate behavior.
- Adding a third-party dependency for budgeting, validation, or randomized testing.

## Design Principles

### Measure the request that is actually sent

Input limits apply to the final serialized JSON string. Every budgeting decision must therefore use `JSON.stringify` on the candidate payload. Raw string length and hand-computed structural overhead are not valid substitutes.

### Preserve identity; compress representation

The models assign existing change-unit IDs. They do not need the full persisted unit schema or repeated `fileId` and `path` fields inside every range. A compact projection may remove redundant representation, but it must retain all unit IDs and the location, status, symbol, commit, and range summary signals needed to reason about them.

### Repair suggestions; never repair truth

Extra model calls may correct a proposed plan. Deterministic code still decides whether the result is publishable. No repair path may invent units, silently normalize closed enums, or bypass exact-coverage and quality checks.

### Degrade locally before degrading globally

One oversized or malformed scout batch should not discard successful scout facts. A planner contract error should consume the bounded repair budget before the entire semantic map falls back.

## Architecture

### 1. Shared model-input projection

Introduce a focused model-input helper used by both the scout and planner builders. It projects a canonical `ReviewChangeUnit` into a compact, model-only shape:

```ts
interface ModelReviewUnit {
  id: string;
  fileId: string;
  path: string;
  symbol?: string;
  status: ReviewChangeUnit["status"];
  commitIds: string[];
  ranges: Array<{
    side: "original" | "modified";
    startLine: number;
    endLine: number;
  }>;
}
```

Range entries omit repeated file identity because their parent unit already supplies it. The helper is deliberately separate from persisted types: changing model-input compression must not change session compatibility or deterministic compilation.

The source projection excludes local repository paths and host-only capabilities. It retains the source kind and label, revision IDs, and relevant pull-request metadata. User-authored and repository-derived free text has these hard maxima before whole-request allocation: 1,000 characters for a source label or pull-request title, 8,000 for a pull-request body, 2,000 for a commit subject or individual scout-fact string, 40 entries per scout-fact string array, 40 relationships per fact, and 40 facts per final scout batch. Truncation is signaled in the payload rather than hidden. IDs, enum values, file paths, line numbers, and the complete unit inventory are never truncated.

### 2. Exact serialized budgeting

Each request builder constructs the full candidate object and serializes it before deciding whether it fits.

For patch-bearing scout requests:

1. Group units as today, with the existing maximum group size.
2. Build one file entry per unique file and load its patch once.
3. Include the compact unit inventory plus `{ fileId, path, unitIds, patch }` file entries.
4. If the full payload exceeds the budget, binary-search a fair per-file patch cap. Each candidate is fully serialized, so the accepted request is guaranteed not to exceed the limit.
5. If the fixed metadata plus empty patches does not fit, split the unit group and retry each half.
6. If one unit's minimum payload cannot fit the configured legal minimum, record a bounded diagnostic for that unit and continue with the remaining groups. Do not throw away prior successful facts.

The allocator favors equal per-file caps so one large file cannot starve the rest of the batch. It may leave unused bytes rather than cross the hard limit. Patch truncation metadata tells the scout that an excerpt, not the complete patch, was supplied.

The planner builder uses the same rule: construct the final payload, serialize it, and ensure it fits. It does not contain full patches. After applying per-field maxima, it allocates the remaining free-text budget round-robin across source prose, commit subjects, and scout facts in stable input order so one verbose fact cannot crowd out all others. It may omit only free-text excerpts that do not fit and reports their counts. It preserves all unit IDs and structural relationship endpoints. Ten percent of the configured request limit, capped at 4,096 characters, is reserved for repair instructions so a repair request cannot push the final planner payload over budget; repair text is sanitized and capped to that reserve.

If complete unit identity alone cannot fit the planner limit, semantic planning stops with a specific input-budget diagnostic and uses the deterministic fallback. Silently omitting units would make exact assignment impossible.

### 3. Resilient scouts

Scout grouping and bounded concurrency remain deterministic. The runner adds two reliability behaviors:

- adaptively split a group whose minimum serialized request cannot fit;
- retry one malformed scout response once for that batch with a short contract-correction instruction.

Successful batch results remain cached under the existing source-fingerprint and unit-derived key. A failed retry produces a diagnostic and contributes no facts, but other batches continue. Parsed scout facts are bounded by count and by string length before they enter the planner payload. A response containing unknown unit IDs is malformed and follows the same single-retry path; it is never partially trusted or forwarded to the planner.

Retry count and split depth are bounded by the original unit count. Concurrency applies to actual model calls, including retries, so adaptation cannot create an unbounded burst.

### 4. One planner contract

Export the allowed chapter priorities and visit roles from the planner module as immutable values used by both validation and prompt construction:

- priorities: `review-first`, `high-attention`, `standard`, `low-attention`, `reference`;
- roles: `start-here`, `contract`, `implementation`, `caller`, `integration`, `removed-path`, `verification`, `reference`.

The planner prompt lists these exact values and states that all IDs must come from the supplied inventory. Keeping prompt text and validation values in the same module prevents them from drifting independently.

The parser remains strict. An unknown enum value is a repairable contract error, not a value to normalize heuristically.

### 5. Shared planner-repair state machine

The semantic runner treats the first planner call as the initial attempt and permits at most two additional planner calls across the entire run. Every additional planner call consumes one shared repair token, regardless of which stage requested it.

The state flow is:

1. Request and parse the initial plan.
2. On JSON or planner-contract failure, request a repair with the sanitized validation error and the exact contract reminders.
3. Run the critic once on the first valid plan.
4. If the critic requests repair, request and validate a new plan using one repair token.
5. Compile the valid plan.
6. If compilation raises the existing repairable map-quality error, request and validate a new plan using one repair token, then compile again.
7. Publish only a plan that passes parsing and compilation. Mark it `semantic-repaired` whenever an additional planner call was used.

If a repair response itself fails parsing, another call may correct it only while a repair token remains. The total is therefore one initial planner call plus no more than two additional planner calls, not two retries per stage.

The critic is advisory; deterministic compilation is authoritative. If the critic response itself is malformed, the runner records a diagnostic and continues to deterministic compilation of the already valid plan. If the critic explicitly requests repair and that repair cannot produce a valid, compilable plan within budget, the map falls back rather than publishing a plan the critic rejected.

Non-quality compiler failures, such as internal invariant violations, do not trigger model repair. They fail closed to fallback with a stage diagnostic.

### 6. Diagnostics and observability

Diagnostics identify the stage, attempt, and bounded cause, for example:

- `map.scout batch 2 split because fixed metadata exceeded 45000 characters`;
- `map.scout batch 3 returned invalid facts on attempt 2`;
- `map.planner contract repair 1/2: invalid chapter priority`;
- `map.compiler quality repair 2/2: supporting share exceeded threshold`.

Diagnostics may include configured and actual character counts and sanitized validator messages. They must not include raw model responses, patch contents, repository secrets, or unbounded exception text.

The final fallback retains accumulated diagnostics so the saved review session explains why semantic mapping degraded.

## Data Flow

```text
canonical units
    -> compact model projection
    -> grouped, patch-deduplicated scout requests
    -> exact serialization check / cap / split
    -> bounded scout facts
    -> bounded planner payload with explicit enums
    -> strict parse
    -> critic
    -> deterministic compile
    -> semantic | semantic-repaired | fallback
```

Only canonical units enter the compiler. The compact projection and truncated patch excerpts are model context, never coverage authority.

## Error Handling

| Failure | Recovery | Terminal behavior |
| --- | --- | --- |
| Scout request is too large | Cap patches, then split batch | Skip only an irreducible unit and retain other facts |
| Scout response is malformed | Retry that batch once | Record diagnostic and continue without that batch's facts |
| Planner JSON or contract is invalid | Consume shared planner-repair token | Fallback after two additional planner calls are exhausted |
| Critic response is malformed | Record diagnostic | Compile the valid plan deterministically |
| Critic requests repair | Consume shared planner-repair token | Fallback if no valid repaired plan is produced |
| Compiler reports repairable quality failure | Consume shared planner-repair token | Fallback if no valid repaired plan compiles |
| Compiler reports invariant/internal failure | No model repair | Fallback with sanitized diagnostic |
| Planner identity inventory cannot fit | No unit omission | Fallback with explicit input-budget diagnostic |

## Testing

### Input projection and budgeting

- Verify repeated units from one file produce one patch-bearing file entry and one patch load.
- Verify every compact unit ID and range remains present after projection.
- Exercise patches containing newlines, quotes, backslashes, tabs, and multibyte Unicode; assert the final serialized string is at or below the configured limit.
- Reproduce the shape of `headout/magellan#669` with synthetic paths, ranges, and escape-heavy patches. Do not commit proprietary patch content.
- Verify a group that cannot fit at minimum patch size is split deterministically.
- Verify an irreducible one-unit payload fails locally with a bounded diagnostic.
- Verify planner prose and scout facts are bounded while all unit IDs remain present.
- Run seeded randomized cases over unit counts, path lengths, shared files, range counts, and escape-heavy patch strings; assert hard size limits, stable ordering, and no duplicate patch entries.

### Scout resilience

- Verify a malformed response is retried once.
- Verify a second malformed response records a diagnostic and other batches still complete.
- Verify successful cached batches are not repeated after a partial failure.
- Verify fact count, string lengths, and unknown unit references are bounded before planning.

### Planner and runner repair

- Verify prompt and parser use the same exported priority and role sets.
- Reproduce the observed invalid-priority response, then return a valid repair; assert `semantic-repaired`.
- Verify malformed JSON followed by a malformed repair and then a valid repair uses exactly three planner calls.
- Verify parser, critic, and compiler repairs share one two-call budget rather than receiving separate budgets.
- Verify an exhausted budget returns fallback with stage diagnostics.
- Verify a malformed critic response does not bypass compilation and does not force fallback by itself.
- Verify strict rejection of invented IDs, duplicate assignments, invalid roles, overlaps, and incomplete coverage is unchanged.

### End-to-end verification

- Run the full automated test suite and static type check.
- Run the repository's diff/format checks.
- Start a clean review of `headout/magellan#669` and confirm the saved map is `semantic` or `semantic-repaired`, never fallback for the two reproduced causes.
- Confirm the viewer remains hidden until that completed semantic map is persisted and delivered.
- Inspect saved diagnostics to ensure retries are bounded and contain no raw model or patch output.

## Acceptance Criteria

- The exact PR #669 scout-budget reproduction produces requests within the configured limit.
- The exact PR #669 invalid-priority reproduction is repaired within the shared budget.
- No request builder returns a serialized payload larger than its configured maximum.
- A file patch appears at most once per scout request.
- No successful scout batch is discarded because a different batch fails.
- A semantic run makes at most three planner calls total and at most two scout calls per final batch.
- Only a strictly parsed and deterministically compiled plan is published.
- Repairs are visible through `semantic-repaired` status and bounded diagnostics.
- Exhausted recovery paths produce a truthful fallback rather than an invalid semantic map or a hung viewer.
- All automated checks pass, and a fresh PR #669 run completes with a semantic map.
