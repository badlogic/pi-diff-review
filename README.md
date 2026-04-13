# pi-diff-review

Native diff review window for pi, powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco.

This fork extends the original package with a branch-aware review mode built around a configurable base ref.

## What it does

Adds a `/diff-review` command to pi.

The command:

1. opens a native review window
2. lets you switch between `base branch`, `git diff`, `last commit`, and `all files` scopes
3. shows a collapsible sidebar with fuzzy file search
4. shows git status markers in the sidebar for changed files and untracked files
5. lazy-loads file contents on demand as you switch files and scopes
6. lets you draft comments on the original side, modified side, or whole file
7. inserts the resulting feedback prompt into the pi editor when you submit

## New branch-aware behavior

- adds a **base branch** scope that compares `merge-base(<baseRef>, HEAD)` to `HEAD`
- supports a configurable base ref via `/diff-review-set-base`
- supports a special `default` base ref setting that resolves to the repo's default remote branch
- defaults the review window to:
  - initial scope: `base branch`
  - hide unchanged regions: `on`
  - wrap lines: `off`
- supports a one-off base ref override with `/diff-review <base-ref>`
- shows the active resolved base ref in the window chrome
- shows effective config with `/diff-review-config`

## Commands

### `/diff-review`

Open the native review window using the saved config.

```bash
/diff-review
```

Override the base ref for one review session:

```bash
/diff-review origin/main
```

### `/diff-review-set-base`

Persist the default base ref for the current project:

```bash
/diff-review-set-base origin/main
```

Use the repository default remote branch:

```bash
/diff-review-set-base default
```

Persist the setting globally:

```bash
/diff-review-set-base --global default
```

### `/diff-review-config`

Show the configured base ref, the effective resolved base ref, and the config file paths.

## Config files

Project-local override:

```text
<repo>/.pi/diff-review.json
```

Global fallback:

```text
~/.pi/agent/pi-diff-review.json
```

Example:

```json
{
  "defaultBaseRef": "default",
  "preferredInitialScope": "base-branch",
  "preferredHideUnchanged": true,
  "preferredWrapLines": false,
  "preferredSidebarCollapsed": false,
  "autoFetchBaseRef": true
}
```

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- internet access for the Tailwind and Monaco CDNs used by the review window

### Windows notes

Glimpse now supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
