# Guided Chapter Transitions and Overall AI Review Result Design

## Problem

The cockpit currently exposes validated AI findings as purple inline markers and chapter-level finding counts. When an AI review completes without findings, those markers are correctly absent, but the viewer provides no prominent, durable confirmation that the review ran or what its overall conclusion was. A compact status line exists in the header, but it is easy to miss and does not expose the model's summary or suggested verdict.

The guided review flow also advances directly from the final semantic visit in one chapter to the first visit in the next chapter. This skips the next chapter's description, review intent, questions, and evidence. Reviewers lose the context that the chapter overview and its `Start review` action are designed to provide.

Reviewers need an explicit overall AI result regardless of whether the AI found zero or many issues, and they need chapter boundaries to remain visible during an otherwise efficient auto-advance workflow.

## Goals

1. Make it immediately clear whether the overall AI review is queued, running, complete, or failed.
2. On completion, show the suggested verdict, validated finding count, reviewed-area count, overall summary, detailed recommendation, accepted risks, and unresolved findings.
3. Keep concise overall AI feedback available inline on every chapter overview and provide an expanded result page at the end of the guided review.
4. Advance automatically between unreviewed semantic visits within a chapter without skipping the next chapter's overview.
5. After the final reviewable chapter is complete, navigate to the expanded overall AI result page instead of another file view.
6. Preserve manual navigation, existing reviewed indicators, and the distinction between overall feedback and chapter-specific findings.
7. Reuse existing review and AI-analysis data without adding a second source of truth.

## Non-Goals

- Changing AI review generation, validation, model routing, or output schemas.
- Creating or publishing GitHub review comments from the result surfaces.
- Replacing purple inline markers or chapter-level AI findings.
- Changing how a reviewer manually selects a chapter or semantic visit in the sidebar.
- Treating a failed or interrupted AI run as a completed review.
- Deriving navigation from filenames; semantic visits remain the review unit.

## Experience Design

### Canvas destinations

The main canvas has three explicit destination types:

1. **Semantic visit** — the existing diff view for a reviewable visit.
2. **Chapter overview** — the existing description page with chapter context and a `Start review` or `Continue review` action.
3. **Overall AI result** — an expanded completion page showing the overall AI review lifecycle and result.

Navigation state must distinguish these destinations directly. A chapter overview or overall result must not be represented as a fabricated file selection.

### Advancing after `Reviewed`

Marking a semantic visit reviewed keeps the current fast path inside a chapter and introduces a deliberate pause at chapter boundaries:

1. If the current chapter has another unreviewed semantic visit, open the earliest such visit in the chapter's defined review order.
2. Otherwise, find the next later chapter that contains an unreviewed semantic visit and open that chapter's overview.
3. If no later chapter is incomplete but an earlier chapter still has an unreviewed visit because the reviewer navigated manually, open the earliest incomplete chapter's overview.
4. Only when no chapter has an unreviewed visit, open the overall AI result page.

Already reviewed visits are skipped during automatic advancement. This supports partially completed and restored sessions without reopening completed work. Fully reviewed later chapters are also skipped because their `Start review` action would have no destination.

The transition logic operates on stable semantic visit identities and their chapter membership. A file represented by multiple visits, including visits split across chapters, advances according to those visits rather than the filename.

### Starting a chapter

On a chapter overview, the primary action opens the earliest unreviewed visit in that chapter:

- label it `Start review` when the chapter has no reviewed visits;
- label it `Continue review` when the chapter is partially reviewed; and
- show the chapter as complete without an enabled start action when all of its visits are reviewed.

Manual selection of any chapter overview or semantic visit remains available and does not alter reviewed state.

### Inline overall AI review card

A full-width **Overall AI review** card appears below the selected chapter's overview header and above the existing chapter-specific `Why this matters` and `AI findings` cards.

The card is repeated on every chapter overview because it describes the entire review, not the selected chapter. It provides concise, durable confirmation while the reviewer moves between chapters. The existing chapter-level AI findings card remains separate so global conclusions are not mixed with local evidence.

For a completed review, the compact card shows:

- an explicit `AI review complete` status;
- the suggested verdict (`Approve`, `Comment`, or `Request changes`);
- the number of validated findings;
- the number of reviewed areas; and
- the approval packet's concise overall summary.

A `View full AI review` action opens the expanded overall AI result page. A `Refresh AI review` action reuses the existing AI review flow.

### Expanded overall AI result page

The expanded page is opened automatically after the final outstanding semantic visit is reviewed. It is also reachable at any time from the header's AI status indicator and from `View full AI review` on a chapter overview.

For a completed review, the page shows:

- `AI review complete` as a textual lifecycle status;
- validated finding count;
- reviewed-area count;
- suggested verdict;
- the approval packet's overall summary and detailed recommendation;
- unresolved findings, with an explicit zero-result state; and
- accepted risks, with an explicit empty state.

The primary action is `Submit review` and opens the existing submission drawer. A secondary `Refresh AI analysis` action reruns the existing AI review flow. Publishing and editing remain in the submission drawer.

The expanded page is a durable destination: rerendering, completing an AI run, or restoring the session must not unexpectedly replace it with a file view.

### AI lifecycle states

Both the compact card and expanded page derive their messaging from the same lifecycle state:

- **Queued / not yet run:** explains that overall feedback is not yet available and offers the existing run action where appropriate.
- **Running:** shows the current progress message and progress indicator from the existing AI review state.
- **Complete:** shows the verdict, counts, summary, and complete feedback even when there are zero findings.
- **Failed / interrupted:** clearly labels the result as incomplete, shows the failure message, and offers `Retry AI review`.

Running and failed states never display stale completion language or a stale suggested verdict. Partial validated findings may remain visible after failure, but the surface must still say that the overall review did not complete. If the reviewer reaches the final result page while analysis is still running, the page remains in place and updates to the completed or failed state when the host result arrives.

## State and Data Flow

### Explicit canvas state

The client state will represent the active canvas destination explicitly, for example as a discriminated value containing a semantic visit, chapter, or overall-result destination. Rendering and navigation use this destination instead of inferring canvas mode solely from the selected filename.

Existing selection state may remain for compatibility with diff rendering, but it is cleared or ignored when a chapter overview or overall result is active. Selecting a sidebar item or invoking a header action sets the corresponding destination deterministically.

### Pure advancement decision

The automatic transition after `Reviewed` will use a pure helper that receives:

- chapters in defined review order;
- ordered semantic visits for each chapter;
- reviewed semantic visit identities; and
- the current semantic visit identity.

It returns exactly one destination: an unreviewed visit in the current chapter, the next incomplete chapter overview, or the overall AI result. Keeping this policy free of DOM and host effects makes boundary, restore, and split-file behavior independently testable.

If the current visit cannot be resolved safely, automatic navigation does not guess. The reviewed state is retained, the current canvas remains stable, and the existing UI can surface a recoverable message while manual navigation stays available.

### Existing AI review data

Both result surfaces read only from data already available to the renderer:

- lifecycle status, message, and progress from `state.aiReview`;
- completion state from `state.aiReviewCompleted` and the persisted AI review status;
- validated findings from `reviewData.analysis.findings`; and
- verdict, summary, body, reviewed chapters, accepted risks, and unresolved findings from `reviewData.analysis.approvalPacket`.

No host protocol, persisted-session schema, or AI output schema change is required for the AI result content. Existing AI review result, completion, failure, and restart messages rerender the active result surface in place.

### Session restoration

Existing reviewed-visit and AI-analysis persistence remains authoritative. On restoration:

- explicit user navigation continues to determine the visible destination when it is already persisted;
- otherwise, existing initial-selection behavior remains unchanged;
- subsequent automatic transitions skip visits already recorded as reviewed; and
- opening the overall result through the header works for restored completed, running, and failed AI states.

If persisting the new canvas destination would require a schema change, it is not required for this feature. Correct review progress and AI result restoration take priority over restoring a transient overview destination exactly.

## Accessibility and Presentation

- Chapter and result destinations receive a programmatic heading and focus target when opened through guided navigation.
- Status and verdict are communicated with text rather than color alone.
- The header AI status is a real button with a clear accessible name when it opens the result page.
- Full feedback preserves readable line breaks and remains selectable.
- Counts have explicit labels and do not rely on icons alone.
- Compact and expanded surfaces use the existing purple AI identity, a distinct success treatment for completion, and the existing error treatment for failures.
- Both surfaces remain legible at the cockpit's narrow layout widths.
- Automatic transitions do not steal focus before the `Reviewed` action completes; focus then moves to the destination heading or primary action.

## Testing

### Advancement policy tests

Focused unit tests for the pure transition helper cover:

- advancing to the next unreviewed visit within the same chapter;
- skipping already reviewed visits within the current chapter;
- opening the next incomplete chapter overview after the chapter's final visit;
- skipping a fully reviewed later chapter;
- wrapping to an earlier incomplete chapter after out-of-order manual navigation;
- opening the overall result after the final outstanding visit;
- split-file semantic visits in the same chapter;
- the same filename represented by visits in different chapters;
- partially completed and restored review state; and
- a missing or invalid current visit returning a safe, non-guessing result.

### Interaction and renderer tests

Focused UI tests cover:

- `Start review` opens the first unreviewed visit;
- a partially reviewed chapter uses `Continue review`;
- a completed chapter has no enabled start action;
- clicking the header AI status opens the expanded result page;
- the final visit transition opens the result page;
- the result page remains active while running analysis updates to completed or failed;
- a zero-finding completed review renders visible completion, verdict, reviewed-area count, and summary;
- complete feedback, accepted risks, and unresolved findings render correctly, including their empty states;
- queued, running, and failed states render truthful, distinct messaging;
- running and failed states do not present stale completion details;
- refresh and retry reuse the existing AI review action; and
- `Submit review` opens the existing submission drawer.

The existing renderer tests, full project test suite, static checks, packaging verification, and a browser smoke test of the guided workflow must continue to pass.

## Acceptance Criteria

- Marking a visit reviewed advances to the next unreviewed visit in the same chapter.
- Completing a chapter opens the next incomplete chapter's overview rather than its first file visit.
- The chapter action starts or continues at that chapter's first unreviewed semantic visit.
- Completing the final outstanding chapter opens the expanded overall AI result page.
- A reviewer can reopen the result page from the header at any time.
- A reviewer can tell from any chapter overview whether the overall AI review ran.
- A completed zero-finding review explicitly shows `0 validated findings` and the overall AI conclusion.
- Overall feedback remains visibly separate from chapter-specific findings.
- A failed or interrupted review is never represented as complete.
- Split-file and restored-session navigation is driven by semantic visits and does not duplicate or skip outstanding review work.
- No backend, host-protocol, AI-output, or required persistence-schema change is introduced.
