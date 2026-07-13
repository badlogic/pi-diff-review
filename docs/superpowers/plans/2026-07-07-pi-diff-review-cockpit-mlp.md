# pi-diff-review-cockpit MLP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first review-cockpit MLP: preserve local `/diff-review`, add `/diff-review pr <url>`, generate a review map and findings inbox, and publish selected GitHub PR review comments only after explicit human action.

**Architecture:** Keep the existing Glimpse + Monaco review window, but add a source-adapter layer that produces a generic `ReviewDataset`. Local review remains one adapter; GitHub PR URL review is the first new adapter and uses an isolated worktree so the user's checkout is untouched. AI analysis runs through Pi's active model with deterministic fallbacks, then the web UI presents Review Map, Findings, Files, comments, and an Approval Packet.

**Tech Stack:** TypeScript ESM, Pi extension API, `@earendil-works/pi-ai` `complete()`, Glimpse, Monaco, Git CLI, GitHub CLI (`gh`), Node.js filesystem APIs, `tsx --test` for focused unit tests, `tsgo --noEmit` for typecheck.

---

## File Structure

- Modify `package.json`: rename package, remove the failing `prepare` install hook, add `test` script, add `tsx` as a dev dependency.
- Modify `package-lock.json`: reflect package rename and `tsx` dev dependency.
- Modify `README.md`: rename project, document local and PR review commands, GitHub publish policy, and install command from `zkewal/pi-diff-review-cockpit`.
- Modify `tsconfig.json`: include tests for typechecking.
- Create `src/sources/types.ts`: source adapter contracts, `ReviewDataset`, `ReviewSourceMetadata`, PR metadata, publish capability metadata.
- Create `src/sources/local.ts`: wraps the existing local git review data as a `ReviewDataset`.
- Create `src/sources/github-pr.ts`: parses GitHub PR URLs, reads PR metadata through `gh`, creates the isolated worktree, applies the PR diff as working tree changes, and returns a `ReviewDataset`.
- Create `src/analysis.ts`: builds AI Review Map, Findings, and Approval Packet draft using `complete()` with fallback analysis when model access fails.
- Create `src/github-publish.ts`: converts accepted comments to a GitHub review payload and publishes with `gh api --input <temp-json>`.
- Modify `src/types.ts`: extend window data and messages for source metadata, analysis, finding statuses, approval packet, and publish requests.
- Modify `src/git.ts`: keep existing git parsing/content loading, export helper types/functions needed by adapters.
- Modify `src/index.ts`: route command args to adapters, run analysis, pass richer window data, handle publish messages, and keep existing finish behavior for non-PR sources.
- Modify `src/prompt.ts`: include accepted findings and approval packet in local prompt output.
- Modify `src/ui.ts`: no architectural change; still inlines window data and JS.
- Modify `web/index.html`: add Review Map, Files, Findings tab controls and right-side insight panel containers.
- Modify `web/app.js`: render source metadata, Review Map, Findings Inbox, approval packet, publish modal, and new host messages.
- Create `tests/github-pr.test.ts`: PR URL parsing and worktree path safety tests.
- Create `tests/github-publish.test.ts`: GitHub review payload generation tests.
- Create `tests/analysis.test.ts`: fallback Review Map and finding-status transition tests.

---

### Task 1: Rename Package And Make Local Development Reliable

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `tsconfig.json`
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Update package metadata and scripts**

Replace `package.json` with this content:

```json
{
  "name": "pi-diff-review-cockpit",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "check": "tsgo --noEmit",
    "test": "tsx --test tests/**/*.test.ts"
  },
  "pi": {
    "extensions": [
      "./src/index.ts"
    ]
  },
  "dependencies": {
    "glimpseui": "^0.8.1"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@types/node": "^24.5.2",
    "@typescript/native-preview": "^7.0.0-dev.20260313.1",
    "husky": "^9.1.7",
    "tsx": "^4.20.6",
    "typescript": "^5.9.2"
  }
}
```

- [ ] **Step 2: Update the lockfile without running lifecycle scripts**

Run:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` updates package name to `pi-diff-review-cockpit` and includes `tsx`.

- [ ] **Step 3: Install dependencies locally without lifecycle scripts**

Run:

```bash
npm install --ignore-scripts
```

Expected: `node_modules/` exists and npm does not run the removed `prepare` hook.

- [ ] **Step 4: Update the README**

Replace `README.md` with this content:

```markdown
# pi-diff-review-cockpit

`pi-diff-review-cockpit` is a review cockpit for Pi. It keeps the fast native diff window from `pi-diff-review`, then adds source adapters, AI-generated review maps, findings triage, approval packets, and explicit GitHub PR review publishing.

## Install

```bash
pi install git:https://github.com/zkewal/pi-diff-review-cockpit
```

For local development:

```bash
pi install /Users/kewalzanzmeria/Desktop/ho-repos/pi-diff-review-cockpit
```

## Commands

```text
/diff-review
/diff-review pr https://github.com/owner/repo/pull/123
```

`/diff-review` preserves local review behavior for working tree diffs, last commit, commit history, and all-files snapshots.

`/diff-review pr <url>` creates an isolated review worktree, loads GitHub PR metadata, generates a Review Map and Findings Inbox, and only publishes comments to GitHub after an explicit human action.

## GitHub Publish Policy

The cockpit reads PR metadata and existing comments when GitHub access is available. It never posts comments, approvals, or change requests automatically. Publishing selected comments as a GitHub review requires a human click in the review window.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- `gh` authenticated for private GitHub PRs
- internet access for the Tailwind and Monaco CDNs used by the review window
```

- [ ] **Step 5: Include tests in TypeScript config**

Change `tsconfig.json` to include tests:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "types/**/*.d.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 6: Add an initial smoke test**

Create `tests/smoke.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

test("test runner is wired", () => {
  assert.equal("pi-diff-review-cockpit".includes("cockpit"), true);
});
```

- [ ] **Step 7: Run checks**

Run:

```bash
npm run check
npm test
```

Expected: `npm run check` passes. `npm test` runs `tests/smoke.test.ts` and passes.

- [ ] **Step 8: Commit**

Run:

```bash
git add package.json package-lock.json README.md tsconfig.json tests/smoke.test.ts
git commit -m "chore: rename diff review cockpit package"
```

Expected: signed commit succeeds.

---

### Task 2: Add Source Contracts And Preserve Local Review Behavior

**Files:**
- Create: `src/sources/types.ts`
- Create: `src/sources/local.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Test: `npm run check`

- [ ] **Step 1: Create source contract types**

Create `src/sources/types.ts`:

```ts
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewCommit, ReviewFile } from "../types.js";

export type ReviewSourceKind =
  | "local-working-tree"
  | "last-commit"
  | "commit"
  | "all-files"
  | "github-pr";

export interface GitHubPullRequestMetadata {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
  baseRefName: string;
  headRefName: string;
  headRepositoryOwner: string;
  isDraft: boolean;
  state: string;
}

export interface ReviewSourceMetadata {
  kind: ReviewSourceKind;
  label: string;
  repoRoot: string;
  workingRoot: string;
  baseRevision: string | null;
  headRevision: string | null;
  github?: GitHubPullRequestMetadata;
  canPublishGitHubReview: boolean;
}

export interface ReviewDataset {
  repoRoot: string;
  workingRoot: string;
  files: ReviewFile[];
  commits: ReviewCommit[];
  source: ReviewSourceMetadata;
}

export interface DiffSourceAdapter {
  name: string;
  matches(args: string[]): boolean;
  build(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<ReviewDataset>;
}
```

- [ ] **Step 2: Extend window data type**

In `src/types.ts`, add this import at the top:

```ts
import type { ReviewSourceMetadata } from "./sources/types.js";
```

Then replace `ReviewWindowData` with:

```ts
export interface ReviewWindowData {
  repoRoot: string;
  workingRoot: string;
  files: ReviewFile[];
  commits: ReviewCommit[];
  source: ReviewSourceMetadata;
  analysis: ReviewAnalysis;
}
```

Add these analysis types above `ReviewWindowData`:

```ts
export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewFindingKind = "bug" | "security" | "migration-risk" | "api-contract" | "test-gap" | "performance" | "question" | "informational";
export type ReviewFindingStatus = "new" | "accepted-comment" | "dismissed" | "accepted-risk";

export interface ReviewLocation {
  fileId: string;
  path: string;
  side: CommentSide;
  line: number | null;
}

export interface ReviewChapter {
  id: string;
  title: string;
  summary: string;
  risk: ReviewFindingSeverity;
  fileIds: string[];
  findingIds: string[];
}

export interface ReviewFinding {
  id: string;
  kind: ReviewFindingKind;
  severity: ReviewFindingSeverity;
  confidence: ReviewFindingSeverity;
  title: string;
  explanation: string;
  suggestedComment: string;
  locations: ReviewLocation[];
  status: ReviewFindingStatus;
}

export interface ApprovalPacket {
  summary: string;
  reviewedChapters: string[];
  acceptedRisks: string[];
  unresolvedFindings: string[];
  suggestedVerdict: "comment" | "request-changes" | "approve";
  body: string;
}

export interface ReviewAnalysis {
  status: "ready" | "fallback" | "failed";
  message: string;
  chapters: ReviewChapter[];
  findings: ReviewFinding[];
  approvalPacket: ApprovalPacket;
}
```

- [ ] **Step 3: Add local adapter**

Create `src/sources/local.ts`:

```ts
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getReviewWindowData } from "../git.js";
import type { ReviewDataset, DiffSourceAdapter } from "./types.js";

export async function buildLocalReviewDataset(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<ReviewDataset> {
  const data = await getReviewWindowData(pi, ctx.cwd);
  return {
    repoRoot: data.repoRoot,
    workingRoot: data.repoRoot,
    files: data.files,
    commits: data.commits,
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot: data.repoRoot,
      workingRoot: data.repoRoot,
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
  };
}

export const localSourceAdapter: DiffSourceAdapter = {
  name: "local",
  matches(args: string[]): boolean {
    return args.length === 0;
  },
  build: buildLocalReviewDataset,
};
```

- [ ] **Step 4: Update `src/index.ts` to use the local adapter**

Change imports:

```ts
import { buildLocalReviewDataset } from "./sources/local.js";
import { createFallbackAnalysis } from "./analysis.js";
```

Remove the import of `getReviewWindowData`.

Inside `reviewRepository`, replace:

```ts
const { repoRoot, files, commits } = await getReviewWindowData(pi, ctx.cwd);
```

with:

```ts
const dataset = await buildLocalReviewDataset(pi, ctx);
const { repoRoot, files, commits } = dataset;
const analysis = createFallbackAnalysis(dataset, "AI analysis has not run yet.");
```

Replace:

```ts
const html = buildReviewHtml({ repoRoot, files, commits });
```

with:

```ts
const html = buildReviewHtml({ ...dataset, analysis });
```

- [ ] **Step 5: Add fallback analysis file**

Create `src/analysis.ts` with this starter implementation:

```ts
import type { ReviewDataset } from "./sources/types.js";
import type { ReviewAnalysis, ReviewChapter, ApprovalPacket } from "./types.js";

function chapterIdFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "changes";
}

function inferChapterTitle(path: string): string {
  if (path.includes("migration")) return "Schema and migrations";
  if (path.includes("/api/")) return "API surface";
  if (path.includes("/models/")) return "Data models";
  if (path.includes("/services/")) return "Service behavior";
  if (path.includes("/tests/") || path.startsWith("tests/")) return "Tests";
  return "Miscellaneous changes";
}

export function createFallbackAnalysis(dataset: ReviewDataset, message: string): ReviewAnalysis {
  const chaptersByTitle = new Map<string, ReviewChapter>();

  for (const file of dataset.files) {
    const title = inferChapterTitle(file.path);
    const existing = chaptersByTitle.get(title);
    if (existing) {
      existing.fileIds.push(file.id);
      continue;
    }

    chaptersByTitle.set(title, {
      id: chapterIdFromTitle(title),
      title,
      summary: `Review ${title.toLowerCase()} before marking this source complete.`,
      risk: title === "Schema and migrations" ? "high" : "medium",
      fileIds: [file.id],
      findingIds: [],
    });
  }

  const chapterTitles = [...chaptersByTitle.values()].map((chapter) => chapter.title);
  const approvalPacket: ApprovalPacket = {
    summary: `${dataset.source.label} contains ${dataset.files.length} reviewable file(s).`,
    reviewedChapters: [],
    acceptedRisks: [],
    unresolvedFindings: [],
    suggestedVerdict: "comment",
    body: [`Reviewed ${dataset.source.label}.`, "", "Chapters:", ...chapterTitles.map((title) => `- ${title}`)].join("\n"),
  };

  return {
    status: "fallback",
    message,
    chapters: [...chaptersByTitle.values()],
    findings: [],
    approvalPacket,
  };
}
```

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 7: Run the extension locally**

Run in any git repo with uncommitted changes:

```bash
pi -e /Users/kewalzanzmeria/Desktop/ho-repos/pi-diff-review-cockpit/src/index.ts
```

Then run inside Pi:

```text
/diff-review
```

Expected: native review window opens with the same file/diff behavior as before.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/sources/types.ts src/sources/local.ts src/types.ts src/index.ts src/analysis.ts
git commit -m "refactor: introduce review source dataset"
```

Expected: signed commit succeeds.

---

### Task 3: Add Command Routing For PR Sources

**Files:**
- Create: `src/command.ts`
- Modify: `src/index.ts`
- Test: `tests/command.test.ts`

- [ ] **Step 1: Add command parser tests**

Create `tests/command.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseDiffReviewArgs } from "../src/command.js";

test("parses empty args as local review", () => {
  assert.deepEqual(parseDiffReviewArgs([]), { mode: "local" });
});

test("parses pr url", () => {
  assert.deepEqual(parseDiffReviewArgs(["pr", "https://github.com/headout/magellan/pull/646"]), {
    mode: "github-pr",
    url: "https://github.com/headout/magellan/pull/646",
  });
});

test("rejects pr without url", () => {
  assert.throws(() => parseDiffReviewArgs(["pr"]), /Usage: \\/diff-review pr <github-pr-url>/);
});

test("rejects unknown source", () => {
  assert.throws(() => parseDiffReviewArgs(["branch", "main"]), /Unsupported diff-review source/);
});
```

- [ ] **Step 2: Add command parser**

Create `src/command.ts`:

```ts
export type DiffReviewCommand =
  | { mode: "local" }
  | { mode: "github-pr"; url: string };

export function parseDiffReviewArgs(args: string[]): DiffReviewCommand {
  if (args.length === 0) {
    return { mode: "local" };
  }

  const [source, value] = args;
  if (source === "pr") {
    if (!value) {
      throw new Error("Usage: /diff-review pr <github-pr-url>");
    }
    return { mode: "github-pr", url: value };
  }

  throw new Error(`Unsupported diff-review source "${source}". Use /diff-review or /diff-review pr <github-pr-url>.`);
}
```

- [ ] **Step 3: Wire parser into command handler**

In `src/index.ts`, import:

```ts
import { parseDiffReviewArgs } from "./command.js";
```

Change `reviewRepository` signature from:

```ts
async function reviewRepository(ctx: ExtensionCommandContext): Promise<void> {
```

to:

```ts
async function reviewRepository(args: string[], ctx: ExtensionCommandContext): Promise<void> {
```

At the start of `reviewRepository`, after the active window check, add:

```ts
const command = parseDiffReviewArgs(args);
if (command.mode !== "local") {
  ctx.ui.notify("GitHub PR review is not implemented in this build yet.", "warning");
  return;
}
```

Change the command handler from:

```ts
handler: async (_args, ctx) => {
  await reviewRepository(ctx);
},
```

to:

```ts
handler: async (args, ctx) => {
  await reviewRepository(args, ctx);
},
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm test
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/command.ts src/index.ts tests/command.test.ts
git commit -m "feat: parse diff review source arguments"
```

Expected: signed commit succeeds.

---

### Task 4: Add GitHub PR URL Parsing And Isolated Worktree Dataset

**Files:**
- Create: `src/sources/github-pr.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `tests/github-pr.test.ts`

- [ ] **Step 1: Add GitHub PR parser tests**

Create `tests/github-pr.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubPrUrl, buildPrWorktreePath } from "../src/sources/github-pr.js";

test("parses github pull request url", () => {
  assert.deepEqual(parseGitHubPrUrl("https://github.com/headout/magellan/pull/646"), {
    owner: "headout",
    repo: "magellan",
    number: 646,
    url: "https://github.com/headout/magellan/pull/646",
  });
});

test("parses devinreview-style github path only when host is github", () => {
  assert.throws(() => parseGitHubPrUrl("https://devinreview.com/headout/magellan/pull/646"), /Expected a github.com PR URL/);
});

test("rejects malformed pull request url", () => {
  assert.throws(() => parseGitHubPrUrl("https://github.com/headout/magellan/issues/646"), /Expected URL path/);
});

test("builds safe cache worktree path", () => {
  const path = buildPrWorktreePath({ owner: "headout", repo: "magellan", number: 646, url: "https://github.com/headout/magellan/pull/646" });
  assert.match(path, /pi-diff-review-cockpit/);
  assert.match(path, /headout--magellan--pr-646$/);
  assert.equal(path.includes(".."), false);
});
```

- [ ] **Step 2: Implement PR URL parsing and cache path**

Create the first part of `src/sources/github-pr.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getReviewWindowData, getRepoRoot } from "../git.js";
import type { DiffSourceAdapter, GitHubPullRequestMetadata, ReviewDataset } from "./types.js";

export interface GitHubPrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export function parseGitHubPrUrl(value: string): GitHubPrRef {
  const url = new URL(value);
  if (url.hostname !== "github.com") {
    throw new Error("Expected a github.com PR URL.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull") {
    throw new Error("Expected URL path /owner/repo/pull/number.");
  }

  const number = Number.parseInt(parts[3], 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Expected a positive pull request number.");
  }

  return {
    owner: parts[0],
    repo: parts[1],
    number,
    url: `https://github.com/${parts[0]}/${parts[1]}/pull/${number}`,
  };
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function buildPrWorktreePath(ref: GitHubPrRef): string {
  return join(
    homedir(),
    ".cache",
    "pi-diff-review-cockpit",
    "github",
    `${safeSegment(ref.owner)}--${safeSegment(ref.repo)}--pr-${ref.number}`,
  );
}
```

- [ ] **Step 3: Implement command helpers in `github-pr.ts`**

Append this code to `src/sources/github-pr.ts`:

```ts
async function run(pi: ExtensionAPI, cwd: string, command: string, args: string[]): Promise<string> {
  const result = await pi.exec(command, args, { cwd, timeout: 120_000 });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runAllowFailure(pi: ExtensionAPI, cwd: string, command: string, args: string[]): Promise<void> {
  await pi.exec(command, args, { cwd, timeout: 120_000 });
}

async function readPrMetadata(pi: ExtensionAPI, cwd: string, ref: GitHubPrRef): Promise<GitHubPullRequestMetadata> {
  const output = await run(pi, cwd, "gh", [
    "pr",
    "view",
    ref.url,
    "--json",
    "number,title,body,author,baseRefName,headRefName,headRepositoryOwner,isDraft,state,url",
  ]);
  const parsed = JSON.parse(output) as {
    number: number;
    title: string;
    body: string | null;
    author: { login: string };
    baseRefName: string;
    headRefName: string;
    headRepositoryOwner: { login: string };
    isDraft: boolean;
    state: string;
    url: string;
  };

  return {
    owner: ref.owner,
    repo: ref.repo,
    number: parsed.number,
    url: parsed.url,
    title: parsed.title,
    body: parsed.body ?? "",
    author: parsed.author.login,
    baseRefName: parsed.baseRefName,
    headRefName: parsed.headRefName,
    headRepositoryOwner: parsed.headRepositoryOwner.login,
    isDraft: parsed.isDraft,
    state: parsed.state,
  };
}
```

- [ ] **Step 4: Implement isolated worktree creation in `github-pr.ts`**

Append this code:

```ts
async function preparePrWorktree(pi: ExtensionAPI, repoRoot: string, ref: GitHubPrRef, metadata: GitHubPullRequestMetadata): Promise<string> {
  const worktreePath = buildPrWorktreePath(ref);
  const patchPath = join(worktreePath, "..", `${safeSegment(ref.owner)}--${safeSegment(ref.repo)}--pr-${ref.number}.patch`);
  const prRemoteRef = `refs/remotes/origin/pr/${ref.number}`;

  await run(pi, repoRoot, "git", ["fetch", "origin", metadata.baseRefName]);
  await run(pi, repoRoot, "git", ["fetch", "origin", `pull/${ref.number}/head:${prRemoteRef}`]);
  await runAllowFailure(pi, repoRoot, "git", ["worktree", "remove", "--force", worktreePath]);
  await run(pi, repoRoot, "mkdir", ["-p", join(worktreePath, "..")]);
  await run(pi, repoRoot, "git", ["worktree", "add", "--detach", worktreePath, `origin/${metadata.baseRefName}`]);
  await run(pi, repoRoot, "git", ["diff", "--binary", `origin/${metadata.baseRefName}...${prRemoteRef}`, "--output", patchPath]);
  await run(pi, worktreePath, "git", ["apply", "--3way", patchPath]);

  return worktreePath;
}
```

- [ ] **Step 5: Implement dataset builder and adapter**

Append this code:

```ts
export async function buildGitHubPrReviewDataset(pi: ExtensionAPI, ctx: ExtensionCommandContext, url: string): Promise<ReviewDataset> {
  const ref = parseGitHubPrUrl(url);
  const repoRoot = await getRepoRoot(pi, ctx.cwd);
  const metadata = await readPrMetadata(pi, repoRoot, ref);
  const worktreePath = await preparePrWorktree(pi, repoRoot, ref, metadata);
  const data = await getReviewWindowData(pi, worktreePath);

  return {
    repoRoot,
    workingRoot: worktreePath,
    files: data.files,
    commits: data.commits,
    source: {
      kind: "github-pr",
      label: `PR #${metadata.number}: ${metadata.title}`,
      repoRoot,
      workingRoot: worktreePath,
      baseRevision: `origin/${metadata.baseRefName}`,
      headRevision: `origin/pr/${metadata.number}`,
      github: metadata,
      canPublishGitHubReview: true,
    },
  };
}

export const githubPrSourceAdapter: DiffSourceAdapter = {
  name: "github-pr",
  matches(args: string[]): boolean {
    return args[0] === "pr" && typeof args[1] === "string";
  },
  async build(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<ReviewDataset> {
    const url = args[1];
    if (!url) {
      throw new Error("Usage: /diff-review pr <github-pr-url>");
    }
    return buildGitHubPrReviewDataset(pi, ctx, url);
  },
};
```

- [ ] **Step 6: Route PR command in `src/index.ts`**

Import:

```ts
import { buildGitHubPrReviewDataset } from "./sources/github-pr.js";
```

Replace the temporary PR warning block with:

```ts
const dataset = command.mode === "github-pr"
  ? await buildGitHubPrReviewDataset(pi, ctx, command.url)
  : await buildLocalReviewDataset(pi, ctx);
```

Remove the old local-only dataset line.

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
npm test
npm run check
```

Expected: PASS.

- [ ] **Step 8: Manual PR dataset test without publishing**

Run in `/Users/kewalzanzmeria/Desktop/ho-repos/magellan`:

```bash
pi -e /Users/kewalzanzmeria/Desktop/ho-repos/pi-diff-review-cockpit/src/index.ts
```

Then in Pi:

```text
/diff-review pr https://github.com/headout/magellan/pull/646
```

Expected: review window opens from a cache worktree under `~/.cache/pi-diff-review-cockpit/github/headout--magellan--pr-646`, and the main `magellan` checkout remains unchanged.

- [ ] **Step 9: Commit**

Run:

```bash
git add src/sources/github-pr.ts src/index.ts tests/github-pr.test.ts
git commit -m "feat: load github pull requests as review sources"
```

Expected: signed commit succeeds.

---

### Task 5: Add AI Review Map And Findings Analysis

**Files:**
- Modify: `src/analysis.ts`
- Modify: `src/index.ts`
- Test: `tests/analysis.test.ts`

- [ ] **Step 1: Add fallback analysis tests**

Create `tests/analysis.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createFallbackAnalysis } from "../src/analysis.js";
import type { ReviewDataset } from "../src/sources/types.js";

function dataset(paths: string[]): ReviewDataset {
  return {
    repoRoot: "/repo",
    workingRoot: "/repo",
    commits: [],
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot: "/repo",
      workingRoot: "/repo",
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
    files: paths.map((path) => ({
      id: path,
      path,
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      gitDiff: {
        status: "modified",
        oldPath: path,
        newPath: path,
        displayPath: path,
        hasOriginal: true,
        hasModified: true,
      },
      lastCommit: null,
      commitComparisons: {},
    })),
  };
}

test("fallback groups migrations, services, api, and tests", () => {
  const analysis = createFallbackAnalysis(dataset([
    "migrations/versions/abc.py",
    "src/app/api/qa_api.py",
    "src/app/services/qa/store.py",
    "tests/app/api/test_qa_api.py",
  ]), "fallback");

  assert.equal(analysis.status, "fallback");
  assert.deepEqual(analysis.chapters.map((chapter) => chapter.title), [
    "Schema and migrations",
    "API surface",
    "Service behavior",
    "Tests",
  ]);
});

test("fallback approval packet mentions source label", () => {
  const analysis = createFallbackAnalysis(dataset(["src/app/api/qa_api.py"]), "fallback");
  assert.match(analysis.approvalPacket.body, /Reviewed Local diff/);
});
```

- [ ] **Step 2: Add AI analysis prompt and JSON parser**

In `src/analysis.ts`, add imports:

```ts
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewAnalysis } from "./types.js";
```

Add this prompt:

```ts
const ANALYSIS_SYSTEM_PROMPT = `You are a senior code reviewer helping a human review faster.

Return strict JSON with this shape:
{
  "chapters": [
    {
      "id": "stable-kebab-case",
      "title": "Short chapter title",
      "summary": "Why the reviewer should read this group",
      "risk": "critical|high|medium|low|info",
      "fileIds": ["file id from input"],
      "findingIds": ["finding id from output"]
    }
  ],
  "findings": [
    {
      "id": "stable-kebab-case",
      "kind": "bug|security|migration-risk|api-contract|test-gap|performance|question|informational",
      "severity": "critical|high|medium|low|info",
      "confidence": "critical|high|medium|low|info",
      "title": "Short finding title",
      "explanation": "Evidence-based explanation",
      "suggestedComment": "Human-facing review comment",
      "locations": [
        { "fileId": "file id from input", "path": "path from input", "side": "modified|original|file", "line": null }
      ],
      "status": "new"
    }
  ],
  "approvalPacket": {
    "summary": "Short PR or diff summary",
    "reviewedChapters": [],
    "acceptedRisks": [],
    "unresolvedFindings": ["finding ids that need attention"],
    "suggestedVerdict": "comment|request-changes|approve",
    "body": "Markdown review summary"
  }
}

Group changes by reviewer reading order, not alphabetical paths. Separate high-confidence bugs from informational explanations. Do not invent files or line numbers. Use null for line when unsure.`;
```

- [ ] **Step 3: Add compact analysis input builder**

In `src/analysis.ts`, add:

```ts
function buildAnalysisInput(dataset: ReviewDataset): string {
  return JSON.stringify({
    source: dataset.source,
    files: dataset.files.map((file) => ({
      id: file.id,
      path: file.path,
      status: file.gitDiff?.status ?? file.worktreeStatus,
      displayPath: file.gitDiff?.displayPath ?? file.path,
      inGitDiff: file.inGitDiff,
      inLastCommit: file.inLastCommit,
    })),
  });
}

function parseAnalysisJson(text: string): ReviewAnalysis {
  const parsed = JSON.parse(text) as ReviewAnalysis;
  return {
    status: "ready",
    message: "AI analysis ready.",
    chapters: parsed.chapters,
    findings: parsed.findings.map((finding) => ({ ...finding, status: finding.status ?? "new" })),
    approvalPacket: parsed.approvalPacket,
  };
}
```

- [ ] **Step 4: Add model-backed analysis function**

In `src/analysis.ts`, add:

```ts
export async function analyzeReviewDataset(ctx: ExtensionCommandContext, dataset: ReviewDataset): Promise<ReviewAnalysis> {
  if (!ctx.model) {
    return createFallbackAnalysis(dataset, "No Pi model is selected, so deterministic fallback analysis was used.");
  }

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) {
      return createFallbackAnalysis(dataset, auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error);
    }

    const userMessage: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: buildAnalysisInput(dataset) }],
    };

    const response = await complete(
      ctx.model,
      { systemPrompt: ANALYSIS_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers },
    );

    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (response.stopReason !== "stop" || text.length === 0) {
      return createFallbackAnalysis(dataset, `AI analysis did not complete cleanly: ${response.stopReason}.`);
    }

    return parseAnalysisJson(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createFallbackAnalysis(dataset, `AI analysis failed: ${message}`);
  }
}
```

- [ ] **Step 5: Use model analysis in `src/index.ts`**

Change the analysis import:

```ts
import { analyzeReviewDataset } from "./analysis.js";
```

Replace:

```ts
const analysis = createFallbackAnalysis(dataset, "AI analysis has not run yet.");
```

with:

```ts
ctx.ui.notify("Analyzing diff for review map and findings.", "info");
const analysis = await analyzeReviewDataset(ctx, dataset);
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
npm test
npm run check
```

Expected: PASS.

- [ ] **Step 7: Manual fallback test**

Run Pi without API credentials for the selected model or with a provider lacking a key:

```bash
pi -e /Users/kewalzanzmeria/Desktop/ho-repos/pi-diff-review-cockpit/src/index.ts
```

Then run:

```text
/diff-review
```

Expected: review window opens and shows deterministic Review Map, with analysis status marked fallback.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/analysis.ts src/index.ts tests/analysis.test.ts
git commit -m "feat: generate review map analysis"
```

Expected: signed commit succeeds.

---

### Task 6: Render Review Map And Findings Inbox In The Window

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `src/types.ts`
- Test: `npm run check`

- [ ] **Step 1: Add sidebar tab controls to `web/index.html`**

Inside the sidebar header, before the scope buttons, add:

```html
<div class="mb-3 grid grid-cols-3 gap-1 rounded-md border border-review-border bg-[#010409] p-1">
  <button id="tab-review-map-button" class="rounded px-2 py-1 text-[11px] font-medium text-review-text">Map</button>
  <button id="tab-files-button" class="rounded px-2 py-1 text-[11px] font-medium text-review-muted">Files</button>
  <button id="tab-findings-button" class="rounded px-2 py-1 text-[11px] font-medium text-review-muted">Findings</button>
</div>
```

- [ ] **Step 2: Add right insight panel to `web/index.html`**

Change the content layout from two columns to include a right panel. Add this sibling after `</main>` and before the closing content layout `</div>`:

```html
<aside id="insight-panel" class="flex min-h-0 w-[360px] shrink-0 flex-col border-l border-review-border bg-[#0d1117]">
  <div class="border-b border-review-border px-4 py-3">
    <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Review context</div>
    <div id="source-label" class="mt-1 truncate text-sm font-medium text-white"></div>
    <div id="analysis-status" class="mt-1 text-[11px] text-review-muted"></div>
  </div>
  <div id="insight-content" class="scrollbar-thin min-h-0 flex-1 overflow-auto px-4 py-3"></div>
</aside>
```

- [ ] **Step 3: Add UI state fields in `web/app.js`**

Add these fields to `state`:

```js
activeSidebarTab: "review-map",
reviewedChapters: {},
findingStatuses: Object.fromEntries((reviewData.analysis?.findings || []).map((finding) => [finding.id, finding.status || "new"])),
acceptedFindingComments: {},
```

Add element references:

```js
const tabReviewMapButton = document.getElementById("tab-review-map-button");
const tabFilesButton = document.getElementById("tab-files-button");
const tabFindingsButton = document.getElementById("tab-findings-button");
const insightPanelEl = document.getElementById("insight-panel");
const insightContentEl = document.getElementById("insight-content");
const sourceLabelEl = document.getElementById("source-label");
const analysisStatusEl = document.getElementById("analysis-status");
```

- [ ] **Step 4: Add tab switch helper in `web/app.js`**

Add:

```js
function setSidebarTab(tab) {
  state.activeSidebarTab = tab;
  renderAll({ restoreFileScroll: false });
}

function updateSidebarTabs() {
  const activeClasses = "rounded bg-[#238636]/15 px-2 py-1 text-[11px] font-medium text-[#3fb950]";
  const inactiveClasses = "rounded px-2 py-1 text-[11px] font-medium text-review-muted hover:bg-[#21262d] hover:text-review-text";
  tabReviewMapButton.className = state.activeSidebarTab === "review-map" ? activeClasses : inactiveClasses;
  tabFilesButton.className = state.activeSidebarTab === "files" ? activeClasses : inactiveClasses;
  tabFindingsButton.className = state.activeSidebarTab === "findings" ? activeClasses : inactiveClasses;
}
```

- [ ] **Step 5: Add Review Map renderer in `web/app.js`**

Add:

```js
function renderReviewMap() {
  fileTreeEl.innerHTML = "";
  const chapters = reviewData.analysis?.chapters || [];
  if (chapters.length === 0) {
    fileTreeEl.innerHTML = `<div class="px-3 py-4 text-sm text-review-muted">No review map available.</div>`;
    return;
  }

  chapters.forEach((chapter, index) => {
    const reviewed = state.reviewedChapters[chapter.id] === true;
    const firstFileId = chapter.fileIds[0];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mb-2 w-full rounded-md border border-review-border bg-review-panel px-3 py-2 text-left hover:bg-[#21262d]";
    button.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Chapter ${index + 1}</span>
        <span class="${reviewed ? "text-[#3fb950]" : "text-review-muted"} text-[11px]">${reviewed ? "Reviewed" : chapter.risk}</span>
      </div>
      <div class="mt-1 text-sm font-semibold text-white">${escapeHtml(chapter.title)}</div>
      <div class="mt-1 text-xs text-review-muted">${escapeHtml(chapter.summary)}</div>
      <div class="mt-2 text-[11px] text-review-muted">${chapter.fileIds.length} file(s) • ${chapter.findingIds.length} finding(s)</div>
    `;
    button.addEventListener("click", () => {
      if (firstFileId) openFile(firstFileId);
      renderInsightForChapter(chapter);
    });
    fileTreeEl.appendChild(button);
  });
}
```

- [ ] **Step 6: Add Findings renderer in `web/app.js`**

Add:

```js
function renderFindings() {
  fileTreeEl.innerHTML = "";
  const findings = reviewData.analysis?.findings || [];
  if (findings.length === 0) {
    fileTreeEl.innerHTML = `<div class="px-3 py-4 text-sm text-review-muted">No AI findings for this diff.</div>`;
    return;
  }

  findings.forEach((finding) => {
    const status = state.findingStatuses[finding.id] || "new";
    const location = finding.locations?.[0];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mb-2 w-full rounded-md border border-review-border bg-review-panel px-3 py-2 text-left hover:bg-[#21262d]";
    button.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">${escapeHtml(finding.kind)}</span>
        <span class="text-[11px] text-review-muted">${escapeHtml(status)}</span>
      </div>
      <div class="mt-1 text-sm font-semibold text-white">${escapeHtml(finding.title)}</div>
      <div class="mt-1 text-xs text-review-muted">${escapeHtml(finding.explanation)}</div>
      <div class="mt-2 text-[11px] text-review-muted">${escapeHtml(location?.path || "No location")}</div>
    `;
    button.addEventListener("click", () => {
      if (location?.fileId) openFile(location.fileId);
      renderInsightForFinding(finding);
    });
    fileTreeEl.appendChild(button);
  });
}
```

- [ ] **Step 7: Add insight renderers in `web/app.js`**

Add:

```js
function renderInsightForChapter(chapter) {
  insightContentEl.innerHTML = `
    <div class="text-sm font-semibold text-white">${escapeHtml(chapter.title)}</div>
    <div class="mt-2 text-sm text-review-muted">${escapeHtml(chapter.summary)}</div>
    <button id="mark-chapter-reviewed" class="mt-4 rounded-md border border-review-border bg-review-panel px-3 py-1.5 text-xs font-medium text-review-text hover:bg-[#21262d]">
      ${state.reviewedChapters[chapter.id] ? "Mark not reviewed" : "Mark chapter reviewed"}
    </button>
  `;
  document.getElementById("mark-chapter-reviewed").addEventListener("click", () => {
    state.reviewedChapters[chapter.id] = !state.reviewedChapters[chapter.id];
    renderAll({ restoreFileScroll: false });
  });
}

function setFindingStatus(finding, status) {
  state.findingStatuses[finding.id] = status;
  if (status === "accepted-comment") {
    state.acceptedFindingComments[finding.id] = finding.suggestedComment;
  }
  renderAll({ restoreFileScroll: false });
}

function renderInsightForFinding(finding) {
  insightContentEl.innerHTML = `
    <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">${escapeHtml(finding.kind)} • ${escapeHtml(finding.severity)}</div>
    <div class="mt-1 text-sm font-semibold text-white">${escapeHtml(finding.title)}</div>
    <div class="mt-3 whitespace-pre-wrap text-sm text-review-muted">${escapeHtml(finding.explanation)}</div>
    <div class="mt-4 rounded-md border border-review-border bg-[#010409] p-3 text-sm text-review-text">${escapeHtml(finding.suggestedComment)}</div>
    <div class="mt-4 grid grid-cols-2 gap-2">
      <button id="finding-accept-comment" class="rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-2 py-1.5 text-xs text-[#3fb950]">Accept comment</button>
      <button id="finding-dismiss" class="rounded-md border border-review-border bg-review-panel px-2 py-1.5 text-xs text-review-text">Dismiss</button>
      <button id="finding-risk" class="rounded-md border border-review-border bg-review-panel px-2 py-1.5 text-xs text-review-text">Accept risk</button>
      <button id="finding-new" class="rounded-md border border-review-border bg-review-panel px-2 py-1.5 text-xs text-review-text">Reset</button>
    </div>
  `;
  document.getElementById("finding-accept-comment").addEventListener("click", () => setFindingStatus(finding, "accepted-comment"));
  document.getElementById("finding-dismiss").addEventListener("click", () => setFindingStatus(finding, "dismissed"));
  document.getElementById("finding-risk").addEventListener("click", () => setFindingStatus(finding, "accepted-risk"));
  document.getElementById("finding-new").addEventListener("click", () => setFindingStatus(finding, "new"));
}
```

- [ ] **Step 8: Update `renderTree` tab branching**

At the start of `renderTree()`, after `fileTreeEl.innerHTML = "";`, add:

```js
updateSidebarTabs();
sourceLabelEl.textContent = reviewData.source?.label || "Review source";
analysisStatusEl.textContent = reviewData.analysis?.message || "";

if (state.activeSidebarTab === "review-map") {
  renderReviewMap();
  return;
}

if (state.activeSidebarTab === "findings") {
  renderFindings();
  return;
}
```

- [ ] **Step 9: Add tab event listeners**

Near the existing event listener setup, add:

```js
tabReviewMapButton.addEventListener("click", () => setSidebarTab("review-map"));
tabFilesButton.addEventListener("click", () => setSidebarTab("files"));
tabFindingsButton.addEventListener("click", () => setSidebarTab("findings"));
```

- [ ] **Step 10: Run typecheck and manual UI check**

Run:

```bash
npm run check
```

Then open:

```text
/diff-review
```

Expected: review window opens with Map, Files, and Findings tabs. Files tab preserves old file tree behavior. Map tab opens by default.

- [ ] **Step 11: Commit**

Run:

```bash
git add web/index.html web/app.js src/types.ts
git commit -m "feat: render review map and findings"
```

Expected: signed commit succeeds.

---

### Task 7: Approval Packet And Local Finish Output

**Files:**
- Modify: `src/types.ts`
- Modify: `src/prompt.ts`
- Modify: `web/app.js`
- Test: `npm run check`

- [ ] **Step 1: Extend submit payload**

In `src/types.ts`, change `ReviewSubmitPayload` to:

```ts
export interface AcceptedFindingComment {
  findingId: string;
  body: string;
}

export interface FindingStatusUpdate {
  findingId: string;
  status: ReviewFindingStatus;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
  acceptedFindings: AcceptedFindingComment[];
  findingStatuses: FindingStatusUpdate[];
  approvalPacket: ApprovalPacket;
}
```

- [ ] **Step 2: Add payload builder in `web/app.js`**

Find the existing finish/submit handler and ensure the payload includes:

```js
function buildSubmitPayload() {
  return {
    type: "submit",
    overallComment: state.overallComment,
    comments: state.comments,
    acceptedFindings: Object.entries(state.acceptedFindingComments).map(([findingId, body]) => ({ findingId, body })),
    findingStatuses: Object.entries(state.findingStatuses).map(([findingId, status]) => ({ findingId, status })),
    approvalPacket: reviewData.analysis?.approvalPacket || {
      summary: "",
      reviewedChapters: [],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "",
    },
  };
}
```

Use `buildSubmitPayload()` wherever the current code sends `{ type: "submit", overallComment, comments }`.

- [ ] **Step 3: Render approval packet modal in `web/app.js`**

Add this function:

```js
function showApprovalPacketModal() {
  const packet = reviewData.analysis?.approvalPacket;
  showTextModal({
    title: "Approval packet",
    description: "Edit the review summary before finishing or publishing.",
    initialValue: packet?.body || "",
    saveLabel: "Save packet",
    onSave: (value) => {
      if (reviewData.analysis?.approvalPacket) {
        reviewData.analysis.approvalPacket.body = value;
      }
    },
  });
}
```

Add a top-bar button in `web/index.html` next to Overall note:

```html
<button id="approval-packet-button" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1.5 text-xs font-medium text-review-text hover:bg-[#21262d]">Approval packet</button>
```

Add element reference and listener in `web/app.js`:

```js
const approvalPacketButton = document.getElementById("approval-packet-button");
approvalPacketButton.addEventListener("click", showApprovalPacketModal);
```

- [ ] **Step 4: Include accepted findings in local prompt output**

In `src/prompt.ts`, inside `composeReviewPrompt`, after the overall comment block, add:

```ts
  if (payload.acceptedFindings.length > 0) {
    lines.push("Accepted AI findings");
    lines.push("");
    payload.acceptedFindings.forEach((finding, index) => {
      lines.push(`${index + 1}. ${finding.body.trim()}`);
      lines.push("");
    });
  }

  const packetBody = payload.approvalPacket.body.trim();
  if (packetBody.length > 0) {
    lines.push("Approval packet");
    lines.push("");
    lines.push(packetBody);
    lines.push("");
  }
```

- [ ] **Step 5: Run checks**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 6: Manual local finish test**

Run:

```text
/diff-review
```

Accept one finding if present, add one manual comment, open Approval Packet, edit text, finish review.

Expected: Pi editor receives overall note, accepted finding comments, approval packet, and manual inline comments.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/types.ts src/prompt.ts web/app.js web/index.html
git commit -m "feat: compose approval packet output"
```

Expected: signed commit succeeds.

---

### Task 8: Explicit GitHub Review Publish

**Files:**
- Create: `src/github-publish.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `web/app.js`
- Modify: `web/index.html`
- Test: `tests/github-publish.test.ts`

- [ ] **Step 1: Add publish payload tests**

Create `tests/github-publish.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildGitHubReviewPayload } from "../src/github-publish.js";
import type { ReviewSubmitPayload } from "../src/types.js";

function payload(): ReviewSubmitPayload {
  return {
    type: "submit",
    overallComment: "Looks good with one note.",
    comments: [{
      id: "c1",
      fileId: "file-1",
      scope: "git-diff",
      side: "modified",
      startLine: 42,
      endLine: null,
      body: "Please add a regression test here.",
    }],
    acceptedFindings: [{ findingId: "f1", body: "This migration needs a rollback note." }],
    findingStatuses: [{ findingId: "f1", status: "accepted-comment" }],
    approvalPacket: {
      summary: "Summary",
      reviewedChapters: [],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "Approval packet body",
    },
  };
}

test("builds github review payload with explicit event", () => {
  const result = buildGitHubReviewPayload({
    event: "COMMENT",
    body: "Review body",
    submit: payload(),
    filePathById: new Map([["file-1", "src/app/api/qa_api.py"]]),
  });

  assert.equal(result.event, "COMMENT");
  assert.equal(result.body, "Review body");
  assert.deepEqual(result.comments, [{
    path: "src/app/api/qa_api.py",
    body: "Please add a regression test here.",
    side: "RIGHT",
    line: 42,
  }]);
});
```

- [ ] **Step 2: Add publish request types**

In `src/types.ts`, add:

```ts
export type GitHubReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

export interface ReviewPublishPayload {
  type: "publish-github-review";
  event: GitHubReviewEvent;
  body: string;
  submit: ReviewSubmitPayload;
}
```

Change `ReviewWindowMessage` to:

```ts
export type ReviewWindowMessage = ReviewSubmitPayload | ReviewCancelPayload | ReviewRequestFilePayload | ReviewPublishPayload;
```

- [ ] **Step 3: Implement GitHub payload builder**

Create `src/github-publish.ts`:

```ts
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitHubPullRequestMetadata } from "./sources/types.js";
import type { DiffReviewComment, GitHubReviewEvent, ReviewSubmitPayload } from "./types.js";

interface BuildPayloadOptions {
  event: GitHubReviewEvent;
  body: string;
  submit: ReviewSubmitPayload;
  filePathById: Map<string, string>;
}

interface GitHubReviewComment {
  path: string;
  body: string;
  side: "LEFT" | "RIGHT";
  line: number;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

interface GitHubReviewPayload {
  event: GitHubReviewEvent;
  body: string;
  comments: GitHubReviewComment[];
}

function toGitHubComment(comment: DiffReviewComment, filePathById: Map<string, string>): GitHubReviewComment | null {
  const path = filePathById.get(comment.fileId);
  if (!path || comment.startLine == null || comment.side === "file") {
    return null;
  }

  const side = comment.side === "original" ? "LEFT" : "RIGHT";
  const result: GitHubReviewComment = {
    path,
    body: comment.body,
    side,
    line: comment.endLine ?? comment.startLine,
  };

  if (comment.endLine != null && comment.endLine !== comment.startLine) {
    result.start_line = comment.startLine;
    result.start_side = side;
  }

  return result;
}

export function buildGitHubReviewPayload(options: BuildPayloadOptions): GitHubReviewPayload {
  return {
    event: options.event,
    body: options.body,
    comments: options.submit.comments
      .map((comment) => toGitHubComment(comment, options.filePathById))
      .filter((comment): comment is GitHubReviewComment => comment != null),
  };
}

export async function publishGitHubReview(
  pi: ExtensionAPI,
  cwd: string,
  metadata: GitHubPullRequestMetadata,
  payload: GitHubReviewPayload,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-publish-"));
  const jsonPath = join(dir, "review.json");
  try {
    await writeFile(jsonPath, JSON.stringify(payload), "utf8");
    const endpoint = `repos/${metadata.owner}/${metadata.repo}/pulls/${metadata.number}/reviews`;
    const result = await pi.exec("gh", ["api", endpoint, "--method", "POST", "--input", jsonPath], { cwd, timeout: 120_000 });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "GitHub review publish failed.");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Add publish button and modal**

In `web/index.html`, add this button next to Finish review:

```html
<button id="publish-github-button" class="hidden cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#1f6feb] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#388bfd]">Publish to GitHub</button>
```

In `web/app.js`, add element reference:

```js
const publishGitHubButton = document.getElementById("publish-github-button");
```

Add:

```js
function showPublishGitHubModal() {
  const packetBody = reviewData.analysis?.approvalPacket?.body || "";
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">Publish GitHub review</div>
      <div class="mb-4 text-sm text-review-muted">This submits selected comments as one GitHub review from your GitHub identity.</div>
      <label class="mb-2 block text-xs font-medium text-review-muted" for="github-review-event">Verdict</label>
      <select id="github-review-event" class="mb-4 w-full rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
        <option value="COMMENT">Comment</option>
        <option value="REQUEST_CHANGES">Request changes</option>
        <option value="APPROVE">Approve</option>
      </select>
      <label class="mb-2 block text-xs font-medium text-review-muted" for="github-review-body">Review body</label>
      <textarea id="github-review-body" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(packetBody)}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="github-publish-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="github-publish-submit" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#1f6feb] px-4 py-2 text-sm font-medium text-white hover:bg-[#388bfd]">Publish review</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector("#github-publish-cancel").addEventListener("click", close);
  backdrop.querySelector("#github-publish-submit").addEventListener("click", () => {
    const event = backdrop.querySelector("#github-review-event").value;
    const body = backdrop.querySelector("#github-review-body").value.trim();
    window.glimpse.send({
      type: "publish-github-review",
      event,
      body,
      submit: buildSubmitPayload(),
    });
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
}
```

Add:

```js
publishGitHubButton.style.display = reviewData.source?.canPublishGitHubReview ? "inline-flex" : "none";
publishGitHubButton.addEventListener("click", showPublishGitHubModal);
```

- [ ] **Step 5: Handle publish message in `src/index.ts`**

Import:

```ts
import { buildGitHubReviewPayload, publishGitHubReview } from "./github-publish.js";
import type { ReviewPublishPayload } from "./types.js";
```

Add type guard:

```ts
function isPublishPayload(value: ReviewWindowMessage): value is ReviewPublishPayload {
  return value.type === "publish-github-review";
}
```

Inside `terminalMessagePromise`, in `onMessage`, add before submit/cancel settling:

```ts
if (isPublishPayload(message)) {
  void handlePublishGitHubReview(message);
  return;
}
```

Add `handlePublishGitHubReview` near `handleRequestFile`:

```ts
const handlePublishGitHubReview = async (message: ReviewPublishPayload): Promise<void> => {
  if (!dataset.source.github) {
    ctx.ui.notify("This review source cannot publish GitHub reviews.", "error");
    return;
  }

  const filePathById = new Map(files.map((file) => [file.id, file.gitDiff?.newPath ?? file.gitDiff?.oldPath ?? file.path]));
  const payload = buildGitHubReviewPayload({
    event: message.event,
    body: message.body,
    submit: message.submit,
    filePathById,
  });

  try {
    await publishGitHubReview(pi, dataset.workingRoot, dataset.source.github, payload);
    ctx.ui.notify("Published GitHub review.", "info");
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`GitHub publish failed: ${messageText}`, "error");
  }
};
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
npm test
npm run check
```

Expected: PASS.

- [ ] **Step 7: Manual publish dry-run behavior**

Open a PR review window and click Publish to GitHub, but cancel the modal.

Expected: no GitHub API call happens.

- [ ] **Step 8: Manual publish test on a disposable PR**

Use a disposable PR where posting a comment is acceptable. Publish a `COMMENT` review with one inline comment.

Expected: GitHub shows one review from the authenticated user. The tool does not post anything before the click.

- [ ] **Step 9: Commit**

Run:

```bash
git add src/github-publish.ts src/types.ts src/index.ts web/app.js web/index.html tests/github-publish.test.ts
git commit -m "feat: publish explicit github reviews"
```

Expected: signed commit succeeds.

---

### Task 9: Final Verification And Install From Fork

**Files:**
- Modify: `README.md` if manual verification finds command or requirement drift.

- [ ] **Step 1: Run full checks**

Run:

```bash
npm test
npm run check
```

Expected: PASS.

- [ ] **Step 2: Verify package install from local path**

Run:

```bash
pi remove git:github.com/badlogic/pi-diff-review
pi install /Users/kewalzanzmeria/Desktop/ho-repos/pi-diff-review-cockpit
pi list
```

Expected: `pi list` shows `/Users/kewalzanzmeria/Desktop/ho-repos/pi-diff-review-cockpit`.

- [ ] **Step 3: Verify local diff review**

In a git repo with a small uncommitted change, run:

```bash
pi
```

Then:

```text
/diff-review
```

Expected: cockpit opens, Review Map appears, Files tab works, comments finish into Pi editor.

- [ ] **Step 4: Verify GitHub PR review worktree isolation**

In `/Users/kewalzanzmeria/Desktop/ho-repos/magellan`, run:

```bash
git status --short --branch
```

Then run in Pi:

```text
/diff-review pr https://github.com/headout/magellan/pull/646
```

After the window opens, run in a separate shell:

```bash
git -C /Users/kewalzanzmeria/Desktop/ho-repos/magellan status --short --branch
```

Expected: main checkout status is unchanged. PR worktree exists under `~/.cache/pi-diff-review-cockpit/github/headout--magellan--pr-646`.

- [ ] **Step 5: Verify no automatic GitHub writes**

Open a PR review window and close it without pressing Publish.

Expected: no new GitHub comments, reviews, approvals, or requested changes appear on the PR.

- [ ] **Step 6: Verify signed commits**

Run:

```bash
git log --show-signature --oneline origin/main..HEAD
```

Expected: every new local commit shows a good signature.

- [ ] **Step 7: Push branch**

Run:

```bash
git push origin main
```

Expected: `zkewal/pi-diff-review-cockpit` receives the signed commits.

---

## Self-Review Checklist

- Spec coverage: Tasks cover rename, local diff preservation, source abstraction, GitHub PR source, isolated worktree, AI Review Map, Findings Inbox, Approval Packet, explicit GitHub publish, and no automatic GitHub writes.
- Scope control: Full live two-way GitHub sync, stacked PRs, code editing from the review window, and saved cross-session review state are excluded.
- Type consistency: `ReviewDataset`, `ReviewAnalysis`, `ReviewFinding`, `ReviewSubmitPayload`, and `ReviewPublishPayload` are introduced before use.
- Test coverage: Pure parsing, fallback analysis, and GitHub payload generation get unit tests. Manual checks cover Glimpse/Monaco behavior and GitHub side effects.
- Safety: PR worktree operations target `~/.cache/pi-diff-review-cockpit`; publishing uses explicit UI action and temporary JSON payloads for `gh api`.
