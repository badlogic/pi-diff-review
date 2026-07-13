# PR Context and Existing Comments Design

## Goal

Give a reviewer enough GitHub context to understand a pull request and continue existing review conversations without permanently narrowing or cluttering the diff canvas.

The feature must make the pull request description and existing comments easy to find, while keeping unresolved inline threads attached to the code that they discuss.

## Non-goals

- Replying to, editing, resolving, or deleting GitHub comments.
- Two-way synchronization of thread state.
- Recreating the GitHub conversation timeline.
- Guessing new anchors for outdated comments.
- Adding a permanent third workspace panel.

## Information hierarchy

1. Unresolved inline review threads are active review work and appear in the diff.
2. The pull request description is orientation material.
3. Resolved threads, outdated threads, review summaries, and conversation comments are reference material.

This hierarchy determines both default visibility and visual prominence.

## Entry points

The top-bar PR title becomes an explicit disclosure control, rendered as `PR #664 review` with a small chevron. Activating it opens the context drawer on the **Overview** tab.

A compact published-thread count near the review status opens the same drawer on the **Threads** tab. The count represents unresolved GitHub review threads, not local staged comments or AI findings.

The command palette exposes `Open PR context`. The single-key `P` shortcut opens the drawer when focus is not inside an input or editor. `Escape` closes it and restores focus to the control or diff location that opened it.

## Context drawer

The drawer temporarily overlays the right side of the workspace. It does not resize the Monaco diff or permanently alter the workspace grid. It uses the existing checkout-drawer interaction pattern for focus containment, keyboard dismissal, and responsive sizing.

The drawer has two tabs only:

### Overview

- PR title and author.
- Base and head branches.
- Draft/open state.
- PR description rendered as safe local Markdown.
- `Open on GitHub` as a low-emphasis external action.

The description is not duplicated on chapter summary pages.

### Threads

The default filter is **Open** and lists unresolved inline review threads. A compact `Open / All` control exposes resolved and outdated inline threads, review summaries, and general PR conversation comments.

Thread rows show only the information required for navigation:

- Author and relative timestamp.
- File and line for current inline threads.
- One-line body preview.
- Comment count.
- `Resolved` or `Outdated` status when applicable.

Selecting a current inline thread closes the drawer, opens its file, scrolls to its exact anchor, expands the published thread, and briefly highlights it. Selecting an outdated or general conversation comment keeps the drawer open and expands that item in place because there is no trustworthy current diff anchor.

## Inline presentation

Unresolved GitHub threads for the active file render expanded by default. The reviewer may collapse them explicitly. Their disclosure state is local UI state and does not alter GitHub.

Published GitHub threads use a muted neutral gutter ring and rail. They must remain visually distinct from:

- Purple AI findings.
- Blue/cyan local human comments.

Resolved threads are hidden from the diff under the default **Open** filter. When **All** is enabled, they appear collapsed unless the reviewer opens them. Outdated threads never attach to a current line.

## Data model

The existing `GitHubPullRequestMetadata.body` remains the source for the Overview description.

Add a cached GitHub review-context snapshot containing:

- `fetchedAt`.
- Repository, PR number, and reviewed head SHA.
- General conversation comments.
- Review summaries.
- Review threads.

Each review thread contains a stable GitHub node ID, resolution and outdated state, path, side, line/original-line metadata, and ordered comments. Each comment contains a stable ID, author, body, creation time, and GitHub URL.

Stable GitHub identifiers are the only deduplication keys. Display text and line numbers are never used as identity.

## Fetch and cache flow

The diff remains instant-on. Opening a GitHub PR review uses the cached context immediately when it matches the same repository, PR number, and reviewed head SHA. A background task then refreshes GitHub context without blocking file navigation or manual commenting.

PR description metadata continues to come from the existing `gh pr view` request. Complete inline review threads are fetched through paginated GitHub GraphQL because `gh pr view` does not expose the full thread model.

The refreshed snapshot is persisted through the existing durable per-source session transaction. A small refresh icon in the drawer provides an explicit retry. The drawer shows `Last synced <time>` rather than a permanent progress module.

## Anchor correctness

A GitHub thread may render inline only when all of these conditions hold:

1. GitHub marks the thread as current, not outdated.
2. Its path identifies a file in the focused PR diff.
3. Its side and line identify a valid line in the current diff model.
4. The cached context head SHA equals the reviewed head SHA.

If any condition fails, the thread remains available in the drawer and is labeled `Outdated` or `Location unavailable`. The cockpit must not search nearby text, infer a replacement line, or silently move the thread.

## Failure behavior

- A GitHub fetch failure never blocks the diff.
- Matching cached context remains readable with a stale timestamp and a retry action.
- With no cache, the Overview remains available from existing PR metadata and Threads shows a compact retry state.
- Malformed or incomplete thread records are rejected individually and reported in diagnostics; valid records still load.
- Authentication errors use an actionable `gh auth` message without exposing command output or credentials in the renderer.

## Rendering safety

PR descriptions and comment bodies are untrusted content. Rendering must escape raw HTML, prohibit scripts and remote embeds, and allow only the local Markdown subset already supported by the application. External links require an explicit user action and open outside the review renderer.

## Acceptance criteria

- The PR description is reachable from the top bar without leaving the review.
- The drawer does not resize the diff canvas.
- The unresolved thread count excludes AI findings, local staged comments, and resolved GitHub threads.
- Current unresolved threads appear expanded at their exact GitHub anchors.
- Selecting a thread navigates to and highlights only that thread.
- Resolved and outdated threads are absent from the default inline view but available under **All**.
- Outdated threads are never attached to guessed current lines.
- Cached context opens immediately and refreshes without blocking review work.
- Fetch failures preserve all local comments, findings, review progress, and diff interaction.
- Keyboard and focus behavior is covered for opening, tab switching, thread navigation, and closing the drawer.

## Test strategy

- Unit-test GraphQL pagination, validation, deduplication, filtering, and head-SHA cache matching.
- Contract-test current, resolved, outdated, deleted-file, and malformed thread records.
- Test exact anchor authorization against the focused diff model.
- Renderer-test drawer focus restoration, `P`, `Escape`, tab/filter state, and thread navigation.
- Test that navigation closes the drawer and pulses only the selected inline thread.
- Test failure and stale-cache states without network access.
- Add a GitHub PR fixture containing description Markdown, conversation comments, review summaries, and multiple threads in one file.
