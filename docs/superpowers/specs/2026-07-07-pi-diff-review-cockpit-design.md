# pi-diff-review-cockpit MLP Design

Date: 2026-07-07

## Goal

Build `pi-diff-review-cockpit`, a Pi extension that helps a human reviewer understand and approve diffs faster by turning raw file changes into a guided review experience.

The main KPI is faster human review and approval, not autonomous review. AI output should orient, prioritize, and draft feedback, while the human remains the reviewer of record.

## Product Positioning

`pi-diff-review-cockpit` is a review cockpit for diff sources. It is not only a GitHub PR reviewer.

The existing `pi-diff-review` tool already supports useful local sources such as working tree diff, last commit, commit history, and all-files snapshot. The cockpit should preserve that direction and add a source abstraction so future sources can feed the same review UI and AI analysis pipeline.

For the MLP, the first new source adapter is GitHub PR URL review.

## MLP Scope

The MLP includes:

- Rename the package and user-facing docs to `pi-diff-review-cockpit`.
- Preserve the existing `/diff-review` command for local diff review.
- Add `/diff-review pr <github-pr-url>`.
- Resolve the PR URL to repository, owner, PR number, base branch, head ref, title, body, author, commits, and changed files.
- Create an isolated temporary or cache worktree for PR review so the user's current checkout is not modified.
- Compute a review dataset from the diff and relevant file contents.
- Generate an AI Review Map that groups related changes into a recommended reading order.
- Generate a Findings Inbox with AI-suggested issues, questions, and informational notes.
- Let the human accept, edit, dismiss, or mark findings as accepted risk.
- Let the human add their own inline and file-level comments.
- Generate an Approval Packet summarizing what was reviewed, remaining risks, accepted risks, and suggested verdict.
- For GitHub PR sources, publish selected comments as an explicit human-triggered GitHub review.
- For non-GitHub sources, finish by inserting a Pi prompt or markdown review packet, matching the current tool's local workflow.

## Non-Goals For MLP

The MLP does not include:

- Full two-way live GitHub comment sync.
- Automatic publishing of AI findings to GitHub.
- Automatic approve or request-changes decisions.
- Editing code from inside the review window.
- Stacked PR support.
- Saved cross-session review state beyond a local cache for analysis results.
- A replacement for GitHub's full review UI.

## GitHub Sync Policy

GitHub integration should be explicit and conservative.

The MLP reads from GitHub:

- PR title, body, author, base branch, head branch, commits, and changed files.
- Existing review comments and unresolved conversation threads when available.
- Check and CI status when available.

The MLP writes to GitHub only after a human clicks a publish action:

- Submit selected inline comments as one GitHub review.
- Choose review event: comment, request changes, or approve.
- Include an optional summary body from the Approval Packet.

The MLP does not keep live two-way sync. If GitHub changes while the review window is open, the UI should offer a refresh action rather than trying to merge remote state automatically.

## Core Concepts

### DiffSourceAdapter

A source adapter gathers source-specific data and returns a generic `ReviewDataset`.

Initial adapters:

- `local-working-tree`: current working tree against `HEAD`.
- `last-commit`: `HEAD` against parent.
- `commit`: selected commit against parent.
- `all-files`: current file snapshot.
- `github-pr`: GitHub PR URL resolved through `gh` or GitHub APIs.

Future adapters:

- branch vs base.
- patch file.
- stacked PR.
- saved review session.

### ReviewDataset

`ReviewDataset` is the generic input to the cockpit UI and AI analysis.

It includes:

- source type and source metadata.
- repository root.
- base revision and head revision when available.
- changed files.
- per-file comparisons.
- hunks or enough file content to derive hunks.
- PR metadata when the source is a GitHub PR.
- existing review comments when available.

### ReviewMap

The Review Map is a human reading plan.

Each chapter includes:

- title.
- short explanation of why the chapter matters.
- ordered files or hunks.
- estimated risk level.
- related findings.
- reviewed state.

Example chapters:

- "Schema and migrations"
- "QA data models"
- "Store service behavior"
- "API endpoints"
- "Tests and fixtures"

### Finding

A finding is an AI-generated review item that the human can act on.

Finding types:

- bug.
- security.
- data migration risk.
- API contract risk.
- test gap.
- performance concern.
- question.
- informational.

Each finding must include:

- title.
- severity.
- confidence.
- explanation.
- evidence locations.
- suggested human-facing comment text.
- status: new, accepted as comment, dismissed, accepted risk, resolved locally.

### Approval Packet

The Approval Packet is generated near the end of review.

It includes:

- short PR summary.
- chapters reviewed.
- high-signal findings accepted as comments.
- dismissed or accepted-risk findings.
- test and CI status when available.
- suggested review verdict.
- optional summary body for GitHub review publication.

## User Flow

### Local Diff Review

1. User runs `/diff-review`.
2. Cockpit opens on the current local diff source, preserving existing behavior.
3. AI analysis runs in the background and updates Review Map and Findings Inbox.
4. User reviews chapters, comments manually, accepts or dismisses findings.
5. User finishes review.
6. Pi receives a feedback prompt or markdown packet.

### GitHub PR Review

1. User runs `/diff-review pr https://github.com/owner/repo/pull/123`.
2. Adapter validates that the current repository matches the PR or can access the PR repository.
3. Adapter creates an isolated worktree for the PR diff.
4. Cockpit opens with PR metadata, Review Map, Findings Inbox, and diff view.
5. User reviews by chapters, not alphabetical file order.
6. User accepts, edits, dismisses, or marks findings as accepted risk.
7. User opens the Approval Packet.
8. User chooses whether to publish to GitHub.
9. If publishing, user selects comment, request changes, or approve.
10. Cockpit submits one explicit GitHub review.

## UI Design

The cockpit keeps Monaco as the central diff viewer.

Layout:

- Left sidebar: Review Map, Files, Findings tabs.
- Center pane: Monaco diff or file viewer.
- Right panel: active chapter context, AI insights, findings for current file, existing GitHub comments, and draft comment actions.
- Top bar: source label, PR status, CI/check status, progress, finish review.

Default mode opens to Review Map, not Files. Files remain available for direct navigation and fuzzy search.

Finding actions:

- Jump to diff.
- Accept as comment.
- Edit comment.
- Dismiss.
- Mark accepted risk.

Review actions:

- Mark chapter reviewed.
- Mark file reviewed.
- Add inline comment.
- Add file comment.
- Add overall note.
- Open Approval Packet.
- Publish selected comments to GitHub when source supports it.

## AI Analysis Pipeline

The AI pipeline can use large context and multiple passes.

Passes:

1. Diff inventory: summarize files, hunks, additions, deletions, moves, and generated-looking code.
2. Review grouping: generate Review Map chapters and reading order.
3. Codebase context: inspect callers, imports, route registration, models, migrations, config, tests, and related files.
4. Risk analysis: generate findings across correctness, security, migration safety, API compatibility, tests, and silent failure modes.
5. Evidence normalization: attach findings to stable file and line references.
6. Approval synthesis: generate final Approval Packet.

Analysis should stream or progressively update. The reviewer should be able to start reading immediately while deeper analysis continues.

## Data Flow

```text
DiffSourceAdapter
  -> ReviewDataset
  -> AI analysis cache
  -> ReviewMap + Findings + ApprovalPacket draft
  -> Glimpse/Monaco cockpit UI
  -> Human decisions
  -> Pi prompt, markdown packet, or explicit GitHub review
```

## Caching

Cache analysis by:

- repository identifier.
- source type.
- base revision.
- head revision.
- diff hash.
- analysis prompt version.

If the diff changes, invalidate the analysis. If only local review state changes, keep the analysis and persist human decisions separately.

## Error Handling

If GitHub metadata cannot be loaded, the PR adapter should fail before opening the cockpit and explain the missing requirement.

If AI analysis fails, the cockpit should still open as a normal diff viewer and show an analysis error with retry.

If GitHub publish fails, comments remain local and the user can retry or export as markdown.

If the PR worktree cannot be created, the adapter should not modify the user's current checkout.

## Privacy And Permissions

The tool should make network behavior clear.

For GitHub PR review:

- `gh` auth or a GitHub token is required for private repositories.
- Publishing requires explicit user action.
- AI analysis may send diffs and relevant file contents to the configured Pi model provider.

The UI should not publish AI findings automatically.

## Testing Strategy

Unit tests:

- PR URL parsing.
- source adapter contracts.
- ReviewDataset generation.
- Review Map and Finding status transitions.
- GitHub review payload generation.

Integration tests:

- local working tree review still opens.
- PR review creates isolated worktree and does not alter the main checkout.
- accepted findings produce correct GitHub review comment payloads.
- failed GitHub publish preserves local comments.

Manual verification:

- run against a public PR.
- run against a private PR with `gh` auth.
- run `/diff-review` with uncommitted local changes.
- confirm no automatic GitHub writes occur.

## Milestones

### Milestone 1: Rename And Source Boundary

- Rename package/docs to `pi-diff-review-cockpit`.
- Introduce `DiffSourceAdapter` and `ReviewDataset`.
- Preserve existing local diff behavior.

### Milestone 2: GitHub PR Source

- Add `/diff-review pr <url>`.
- Fetch PR metadata.
- Create isolated worktree.
- Compute PR diff dataset.

### Milestone 3: Review Map

- Add AI-generated chapters.
- Add Review Map tab.
- Let humans mark chapters reviewed.

### Milestone 4: Findings Inbox

- Add AI-generated findings.
- Add accept/edit/dismiss/accepted-risk actions.
- Link findings to files and hunks.

### Milestone 5: Approval Packet And GitHub Publish

- Generate Approval Packet.
- Submit selected comments as one explicit GitHub review.
- Support comment, request changes, and approve events.

## Acceptance Criteria

The MLP is successful when a user can review a GitHub PR through the cockpit without touching their main checkout, follow an AI-generated reading order, triage AI findings, add or edit human comments, and explicitly publish one GitHub review.

The existing `/diff-review` local workflow must continue to work.

No GitHub comments, approvals, or review requests may be published without an explicit human click.
