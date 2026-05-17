# pi-diff-review

This is pure slop, see: https://pi.dev/session/#d4ce533cedbd60040f2622dc3db950e2

It is my hope, that someone takes this idea and makes it gud.

Native diff review window for pi, powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco.

```
pi install git:https://github.com/badlogic/pi-diff-review
```

## What it does

Adds a `/diff-review` command to pi.

The command:

1. opens a review window (native by default, or in your browser with `--web`)
2. lets you switch between `git diff`, `last commit`, and `all files` scopes
3. shows a collapsible sidebar with fuzzy file search
4. shows git status markers in the sidebar for changed files and untracked files
5. lazy-loads file contents on demand as you switch files and scopes
6. lets you draft comments on the original side, modified side, or whole file
7. inserts the resulting feedback prompt into the pi editor when you submit

## Web mode for SSH/remote workflows

If pi runs on a remote machine (for example inside zellij over SSH), use web mode:

```bash
/diff-review --web --port 8787
```

This starts a temporary web server and prints:

- full review URL
- a secret token path like `/diff-review-<token>`

Open the URL in your local browser, review, and submit. The prompt is inserted back into the remote pi editor.

### Useful flags

```bash
/diff-review --web --port 8787
/diff-review --web --host 0.0.0.0 --port 8787
/diff-review --web --public --port 8787
```

- `--web`: use browser UI instead of native window
- `--port`: choose the listening port (defaults to random free port)
- `--host`: bind host address (default `127.0.0.1`)
- `--public`: shortcut for `--host 0.0.0.0`

### Active token helper

Use this while a web review is running:

```bash
/diff-review-token
```

It shows the current review URL and secret token path.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- internet access for the Tailwind and Monaco CDNs used by the review window

### Windows notes

Glimpse now supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
