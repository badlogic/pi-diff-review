# pi-diff-review-cockpit

`pi-diff-review-cockpit` is a review cockpit for Pi. It supports local working tree review and GitHub PR review with AI-generated review maps, findings triage, staged comments, and explicit GitHub review submission.

## Install

```bash
pi install git:https://github.com/zkewal/pi-diff-review-cockpit
```

For local development:

```bash
pi install /Users/kewalzanzmeria/Desktop/ho-repos/pi-diff-review-cockpit
```

To put the direct CLI on your shell `PATH` during local development:

```bash
npm install
npm link
```

Without linking, run the CLI through npm:

```bash
npm run cli -- pr https://github.com/owner/repo/pull/123
```

## Commands

From a terminal:

```bash
pi-diff-review
pi-diff-review pr https://github.com/owner/repo/pull/123
pi-diff-review --reset-review pr https://github.com/owner/repo/pull/123
pi-diff-review --repo /path/to/repo pr https://github.com/owner/repo/pull/123
```

Inside Pi:

```text
/diff-review
```

`/diff-review` preserves local review behavior for working tree diffs, last commit, commit history, and all-files snapshots.

## GitHub PR Review

```text
/diff-review pr https://github.com/owner/repo/pull/123
```

`/diff-review pr <url>` loads GitHub PR metadata, fetches private base/head review refs, and opens the cockpit review window for the PR diff without creating a detached cache worktree.

Click the PR title, the compact thread count, or press `P` to open the temporary pull request context drawer. **Overview** shows the PR description; **Threads** shows existing GitHub conversation, review, and inline-thread history. Current unresolved inline threads are also expanded at their exact diff anchors by default. Resolved and outdated history remains available under **All**, and any thread that cannot be matched exactly to the reviewed head stays in the drawer instead of being guessed onto a line.

Imported GitHub context is read-only in the cockpit. It is cached with the local review session for fast reopen, refreshed asynchronously, and kept separate from locally staged comments and the review submission payload.

Use `--reset-review` to clear saved cockpit metadata for the selected local diff or PR before opening the review again:

```bash
pi-diff-review --reset-review pr https://github.com/owner/repo/pull/123
pi-diff-review pr https://github.com/owner/repo/pull/123 --reset-review
```

This removes the saved review map, AI findings, staged local comments, and review progress for that one review source. It does not reset Git files, branches, refs, or worktrees. `--fresh` is accepted as a short alias, but `--reset-review` is the preferred spelling.

If an earlier GitHub submission remains ambiguous after reconciliation, the cockpit opens in review-only mode and blocks another publish. `--abandon-ambiguous-publish` explicitly discards only that publish intent while preserving comments and review progress:

```bash
pi-diff-review --abandon-ambiguous-publish pr https://github.com/owner/repo/pull/123
```

Use this only after checking GitHub. The prior request may already have succeeded, so publishing again can create a duplicate GitHub review.

## PI Review Configuration

The diff opens with a deterministic provisional review plan. Semantic mapping then runs in the background through bounded scouts, a global planner, an adversarial critic, and an exact-coverage compiler. Only a map that owns every changed line exactly once is published to the UI. If semantic mapping fails, the provisional plan remains usable and is labeled as fallback rather than being presented as AI-generated.

Review progress is stored per semantic visit. Different changed ranges in one large file may therefore belong to different chapters; the file is complete only after every visit is complete. A matching diff fingerprint and mapping strategy restore the cached map without repeating model work. A changed PR head invalidates generated maps and findings while retaining only human state that can be reconciled safely.

AI review defaults to `standard` depth and three parallel chapter agents. Standard routing uses `openai-codex/gpt-5.6-luna` at `medium` for scouting, `openai-codex/gpt-5.6-terra` at `high` for chapter agents, `openai-codex/gpt-5.6-sol` at `xhigh` for validation, and Terra at `high` for synthesis. Pi 0.80.6 or newer is required to expose these model IDs; older 0.80.x installations fall back to the active Pi model with a warning.

| Phase | Fast | Standard | Deep |
| --- | --- | --- | --- |
| Scout | Luna `low` | Luna `medium` | Terra `high` |
| Chapter agents | Luna `medium` | Terra `high` | Sol `xhigh` |
| Validation critic | Terra `high` | Sol `xhigh` | Sol `max` |
| Synthesis | Luna `medium` | Terra `high` | Sol `xhigh` |

Configuration is dependency-free JSON for now. The cockpit reads, in order:

- `~/.config/pi-diff-review-cockpit/config.json`
- `<repo>/.pi-diff-review-cockpit/config.json`
- `<repo>/pi-diff-review-cockpit.config.json`
- `PI_DIFF_REVIEW_COCKPIT_CONFIG=/path/to/config.json`

Later files override earlier files. Example:

```json
{
  "aiReview": {
    "depth": "deep",
    "parallelChapterReviews": 2,
    "maxFindingsPerChapter": 12,
    "skills": {
      "preset": "balanced",
      "enabled": ["correctness", "contracts", "tests", "silent-failures", "security", "comments"],
      "custom": [
        {
          "id": "team-qa",
          "title": "Team QA contracts",
          "focus": "Headout QA workflow assumptions.",
          "instructions": "Check QA label lifecycle and benchmark data compatibility before suggesting approval."
        }
      ],
      "additionalInstructions": "Prefer fewer, higher-confidence comments."
    },
    "phases": {
      "scout": { "provider": "openai-codex", "model": "gpt-5.6-luna", "reasoning": "medium" },
      "chapter": { "provider": "openai-codex", "model": "gpt-5.6-terra", "reasoning": "high" },
      "validation": { "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning": "xhigh" },
      "synthesis": { "provider": "openai-codex", "model": "gpt-5.6-terra", "reasoning": "high" }
    },
    "map": {
      "scout": { "provider": "openai-codex", "model": "gpt-5.6-luna", "reasoning": "medium" },
      "planner": { "provider": "openai-codex", "model": "gpt-5.6-terra", "reasoning": "high" },
      "critic": { "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning": "xhigh" }
    }
  }
}
```

Skill presets are `minimal`, `balanced`, `security`, and `exhaustive`. If `skills` is omitted, `balanced` is used. Unknown skills are ignored with a warning; if a config accidentally disables every skill, review falls back to `correctness`.

Reasoning values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A configured level is used only when the selected model supports it.

For a short explicit skill list, this is also accepted:

```json
{
  "aiReview": {
    "skills": ["correctness", "security", "tests"]
  }
}
```

## GitHub Publish Policy

The cockpit workflow reads PR metadata when GitHub access is available. It will not post comments, approvals, or change requests automatically. Publishing selected comments as a GitHub review requires a human click in the review window.

## Requirements

- macOS
- Node.js 22.19+
- Pi 0.80.6+ installed for GPT-5.6 routing
- `gh` authenticated for private GitHub PRs in the cockpit workflow

## Renderer Assets

The review renderer is built locally during `prepare`; Tailwind, Monaco, and the five worker programs used by the UI are bundled into `web/dist` and the review shell does not request remote scripts, styles, or modules. Build tools are development dependencies: source and git installs can run `prepare`, while packed runtime installs consume the included `web/dist` assets without installing Tailwind, esbuild, or Monaco.

Glimpse 0.8.1's macOS `loadFileURL` path also does not execute local ES module scripts, and WKWebView cannot start Monaco workers directly from the shell's `file:` URLs. The renderer therefore ships as a prebundled local classic script and starts its embedded worker programs from revocable `blob:` URLs. The CSP keeps scripts local, denies connections, and permits `blob:` only for workers.
