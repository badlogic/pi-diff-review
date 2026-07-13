# PR Context and Existing Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a temporary PR-context drawer and exact, read-only rendering of existing GitHub review threads without reducing diff space or mixing imported comments into the local publish workflow.

**Architecture:** Keep GitHub context as a strict host-owned snapshot, cached in the durable review session and refreshed asynchronously after the native diff opens. Fetch complete comments and threads through paginated `gh api graphql`, validate records independently, and send authenticated refresh results to the renderer. The renderer owns only drawer/filter/disclosure presentation; imported threads never enter `state.comments`, and only current, exact GitHub anchors render inline.

**Tech Stack:** TypeScript, Node.js, `gh` CLI GraphQL API, Glimpse native window messaging, Monaco diff editor, browser JavaScript/CSS, Node test runner.

---

## File Structure

- Create `src/github-review-context.ts`: GraphQL queries, pagination, strict normalization, deduplication, and diagnostics.
- Create `web/github-review-context.js`: pure renderer selectors for filters, counts, anchor eligibility, and disclosure state.
- Create `web/safe-markdown.js`: small escaped Markdown subset for PR descriptions and comment bodies; no raw HTML or embeds.
- Create `tests/github-review-context.test.ts`: host fetch/parser/pagination tests.
- Create `tests/github-review-context-renderer.test.ts`: pure renderer state and exact-anchor tests.
- Create `tests/safe-markdown.test.ts`: rendering and injection tests.
- Modify `src/types.ts`: context types, refresh request, host result messages, and host-owned session field.
- Modify `src/session-store.ts`: strict persisted-context validation and renderer-merge protection.
- Modify `src/renderer-protocol.ts`: authenticated refresh command decoding.
- Modify `src/review-window.ts`: host-message validation for GitHub context results.
- Modify `src/index.ts`: cached bootstrap, asynchronous refresh, durable persistence, retry handling, and lifecycle guards.
- Modify `web/index.html`: top-bar disclosure controls and temporary context drawer shell.
- Modify `web/app.js`: context state, drawer behavior, refresh lifecycle, thread list, Monaco view zones, navigation, and keyboard command.
- Modify `web/review.css`: drawer, published-thread gutter/rail, disclosure, and pulse styling.
- Modify existing protocol, window, session, smoke, and GitHub source tests for the new contract.

## Invariants

1. Imported GitHub context never enters `ReviewSessionSnapshot.comments` or renderer `state.comments`.
2. The renderer cannot persist or overwrite `githubContext`; it is host-owned like `analysis` and `githubPublishIntent`.
3. A thread renders inline only when the context head matches the reviewed head, GitHub marks it current, its path maps uniquely to a focused diff file, and its side/line exists in the loaded Monaco model.
4. Outdated or unlocatable threads remain navigable in the drawer but are never guessed onto a line.
5. Context fetch, parse, or cache failures never block file navigation, local comments, AI review, or GitHub submission.

---

### Task 1: Define and persist the host-owned context contract

**Files:**
- Modify: `src/types.ts` near `ReviewSessionSnapshot` and `ReviewHostMessage`
- Modify: `src/session-store.ts` in `isReviewSnapshot`, `mergeRendererSessionCheckpoint`, and stale reconciliation
- Test: `tests/session-store.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Add tests proving that a valid context round-trips, malformed nested records fail strict loading, renderer checkpoints cannot overwrite the host-owned context, and stale diff reconciliation drops the cached context.

```ts
test("GitHub context is host-owned and survives a matching session round trip", async () => {
  const context = githubContextSnapshot();
  const stored = await persistValidSession({ githubContext: context });
  assert.deepEqual(stored.snapshot.githubContext, context);

  const merged = mergeRendererSessionCheckpoint(stored.snapshot, {
    comments: [],
    githubContext: { owner: "attacker" },
  } as never);
  assert.deepEqual(merged.githubContext, context);
});

test("stale reconciliation drops cached GitHub context", () => {
  const reconciled = reconcileStaleSession({ githubContext: githubContextSnapshot() });
  assert.equal(reconciled.snapshot.githubContext, undefined);
});
```

- [ ] **Step 2: Run the tests and verify red state**

Run: `npx tsx --test tests/session-store.test.ts`

Expected: FAIL because `githubContext` is not an accepted session field and the test fixture/type does not exist.

- [ ] **Step 3: Add the normalized context types**

Define the exact public contract in `src/types.ts`:

```ts
export interface GitHubContextComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface GitHubReviewSummary extends GitHubContextComment {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
}

export interface GitHubReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  side: "original" | "modified" | null;
  line: number | null;
  originalLine: number | null;
  comments: GitHubContextComment[];
}

export interface GitHubReviewContextSnapshot {
  owner: string;
  repo: string;
  pullNumber: number;
  reviewedHeadSha: string;
  remoteHeadSha: string;
  fetchedAt: string;
  conversationComments: GitHubContextComment[];
  reviews: GitHubReviewSummary[];
  threads: GitHubReviewThread[];
  diagnostics: string[];
}
```

Add `githubContext?: GitHubReviewContextSnapshot` to `ReviewSessionSnapshot`, and omit it from `ReviewRendererSessionSnapshot`:

```ts
export type ReviewRendererSessionSnapshot = Omit<
  ReviewSessionSnapshot,
  "analysis" | "githubPublishIntent" | "githubContext"
>;
```

- [ ] **Step 4: Add strict nested validation and host ownership**

Extend `isReviewSnapshot` with exact-key validation for every context, thread, review, and comment field. Require unique IDs within each collection, positive integer lines, valid ISO timestamps, and a positive PR number. Do not coerce malformed values.

Ensure `mergeRendererSessionCheckpoint()` takes `githubContext` only from the host snapshot. Do not copy `githubContext` in `reconcileStaleReviewSession()` because a changed fingerprint may represent a different head.

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test tests/session-store.test.ts`

Expected: PASS, including the new host-ownership and stale-drop cases.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/session-store.ts tests/session-store.test.ts
git commit -m "feat: define durable GitHub review context"
```

---

### Task 2: Fetch and normalize complete GitHub review context

**Files:**
- Create: `src/github-review-context.ts`
- Create: `tests/github-review-context.test.ts`
- Modify: `tests/github-pr.test.ts`

- [ ] **Step 1: Write failing parser and pagination tests**

Cover multiple pages of conversation comments, reviews, and review threads; a thread with more than one page of comments; duplicate node IDs; null authors; malformed individual records; current and outdated locations; and a remote head different from the reviewed head.

```ts
test("fetches and deduplicates every GitHub review-context connection", async () => {
  const result = await fetchGitHubReviewContext(fakePi(graphqlPages), "/repo", {
    owner: "headout",
    repo: "magellan",
    pullNumber: 664,
    reviewedHeadSha: "reviewed-head",
  });

  assert.equal(result.remoteHeadSha, "reviewed-head");
  assert.deepEqual(result.conversationComments.map((item) => item.id), ["issue-1", "issue-2"]);
  assert.deepEqual(result.reviews.map((item) => item.id), ["review-1"]);
  assert.deepEqual(result.threads.map((item) => item.id), ["thread-1", "thread-2"]);
  assert.deepEqual(result.threads[0]?.comments.map((item) => item.id), ["reply-1", "reply-2"]);
});

test("rejects malformed records individually without losing valid siblings", async () => {
  const result = await fetchGitHubReviewContext(fakePi(malformedPage), "/repo", source);
  assert.deepEqual(result.threads.map((item) => item.id), ["valid-thread"]);
  assert.match(result.diagnostics.join("\n"), /Skipped malformed review thread/);
});
```

- [ ] **Step 2: Run tests and verify red state**

Run: `npx tsx --test tests/github-review-context.test.ts`

Expected: FAIL because `src/github-review-context.ts` does not exist.

- [ ] **Step 3: Implement a small GraphQL runner**

Use `pi.exec("gh", ["api", "graphql", "-f", `query=${query}`, ...variables])` with the repository root as `cwd` and the existing 120-second timeout convention. Parse stdout as unknown JSON and surface only sanitized error summaries.

Expose one public function:

```ts
export interface FetchGitHubReviewContextOptions {
  owner: string;
  repo: string;
  pullNumber: number;
  reviewedHeadSha: string;
}

export async function fetchGitHubReviewContext(
  pi: ExtensionAPI,
  cwd: string,
  options: FetchGitHubReviewContextOptions,
): Promise<GitHubReviewContextSnapshot>;
```

- [ ] **Step 4: Implement independent cursor loops**

Use separate paginated queries for pull-request conversation comments, review summaries, and review threads. Request `headRefOid` with every top-level query. For thread comments whose nested `pageInfo.hasNextPage` is true, paginate that thread through `node(id: $threadId) { ... on PullRequestReviewThread { comments(...) } }`.

Normalize `diffSide` as:

```ts
function normalizeSide(value: unknown): "original" | "modified" | null {
  if (value === "LEFT") return "original";
  if (value === "RIGHT") return "modified";
  return null;
}
```

Use stable node IDs for deduplication and preserve GitHub order. Treat a null author as `ghost`; reject records missing IDs, bodies, timestamps, or URLs. Bound every connection to 10,000 records and fail the refresh if pagination repeats a cursor.

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test tests/github-review-context.test.ts tests/github-pr.test.ts`

Expected: PASS with deterministic pagination and diagnostics.

- [ ] **Step 6: Commit**

```bash
git add src/github-review-context.ts tests/github-review-context.test.ts tests/github-pr.test.ts
git commit -m "feat: fetch GitHub review context"
```

---

### Task 3: Add authenticated asynchronous refresh and durable caching

**Files:**
- Modify: `src/types.ts`
- Modify: `src/renderer-protocol.ts`
- Modify: `src/review-window.ts`
- Modify: `src/index.ts`
- Test: `tests/renderer-protocol.test.ts`
- Test: `tests/review-window.test.ts`
- Test: `tests/publish-lifecycle.test.ts`

- [ ] **Step 1: Write failing protocol and lifecycle tests**

Test that only authenticated `refresh-github-context` and HTTPS `open-external-url` requests are accepted, context results cannot be forged by renderer messages, a matching cache is included in bootstrap, refresh starts only after renderer boot, repeated refresh requests coalesce, and window close prevents late sends without delaying shutdown.

```ts
test("decodes only an authenticated GitHub context refresh request", () => {
  assert.deepEqual(decode(frame({ type: "refresh-github-context", requestId: "context-1" })), {
    type: "refresh-github-context",
    requestId: "context-1",
  });
  assert.equal(decode({ type: "refresh-github-context-result", context: forged }), null);
});

test("accepts only HTTPS external URLs", () => {
  assert.deepEqual(decode(frame({ type: "open-external-url", url: "https://github.com/o/r/pull/1" })), {
    type: "open-external-url",
    url: "https://github.com/o/r/pull/1",
  });
  assert.equal(decode(frame({ type: "open-external-url", url: "javascript:alert(1)" })), null);
});

test("late GitHub context refresh does not send after window close", async () => {
  const refresh = deferred<GitHubReviewContextSnapshot>();
  const host = openHost({ fetchContext: () => refresh.promise });
  host.close();
  refresh.resolve(githubContextSnapshot());
  await host.settled;
  assert.equal(host.sent.some((item) => item.type === "github-context-result"), false);
});
```

- [ ] **Step 2: Run tests and verify red state**

Run: `npx tsx --test tests/renderer-protocol.test.ts tests/review-window.test.ts tests/publish-lifecycle.test.ts`

Expected: FAIL because refresh request/result types and host handling are absent.

- [ ] **Step 3: Add request and result messages**

Add these contracts to `src/types.ts`:

```ts
export interface ReviewRefreshGitHubContextPayload {
  type: "refresh-github-context";
  requestId: string;
}

export interface ReviewOpenExternalUrlPayload {
  type: "open-external-url";
  url: string;
}

export type ReviewGitHubContextResultMessage = {
  type: "github-context-result";
  requestId: string;
  ok: true;
  context: GitHubReviewContextSnapshot;
} | {
  type: "github-context-result";
  requestId: string;
  ok: false;
  message: string;
  cachedContext?: GitHubReviewContextSnapshot;
};
```

Include both renderer requests in `ReviewWindowMessage` and the result in `ReviewHostMessage`. Decode only HTTPS URLs no longer than 2,048 characters. In `src/index.ts`, revalidate the URL and launch it with `pi.exec("open", [url])`, never a shell command string. Validate host context results before injection in `review-window.ts`, using the same strict context validator as persistence.

- [ ] **Step 4: Implement one coalesced host refresh**

In `src/index.ts`, include `sessionSnapshot?.githubContext` in bootstrap only when owner, repo, PR number, and `reviewedHeadSha` match the active source. After renderer boot, invoke `fetchGitHubReviewContext()` without awaiting it before the diff becomes usable.

Use one in-flight promise:

```ts
let githubContextRefresh: Promise<GitHubReviewContextSnapshot> | null = null;

const refreshGitHubContext = (): Promise<GitHubReviewContextSnapshot> => {
  if (githubContextRefresh != null) return githubContextRefresh;
  githubContextRefresh = fetchGitHubReviewContext(pi, dataset.workingRoot, source)
    .finally(() => { githubContextRefresh = null; });
  return githubContextRefresh;
};
```

On success, merge the context into the host snapshot, queue the existing durable save, then send `github-context-result`. On failure, send a sanitized message and the matching cache. Guard every send with the active window/lifecycle checks already used by AI progress.

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test tests/renderer-protocol.test.ts tests/review-window.test.ts tests/publish-lifecycle.test.ts tests/session-store.test.ts`

Expected: PASS, with no change to publish or close semantics.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/renderer-protocol.ts src/review-window.ts src/index.ts tests/renderer-protocol.test.ts tests/review-window.test.ts tests/publish-lifecycle.test.ts
git commit -m "feat: stream cached GitHub context to reviews"
```

---

### Task 4: Build the safe PR-context drawer

**Files:**
- Create: `web/safe-markdown.js`
- Create: `tests/safe-markdown.test.ts`
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/review.css`
- Test: `tests/smoke.test.ts`

- [ ] **Step 1: Write failing rendering and drawer tests**

Test escaped raw HTML, headings, lists, fenced code, inline code, safe HTTPS links, rejected `javascript:` links, drawer overlay behavior, Overview/Threads tabs, `Open / All`, focus restoration, `P`, `Escape`, external link dispatch, and absence for local diff sources.

```ts
test("safe Markdown never emits supplied HTML or unsafe links", () => {
  const html = renderSafeMarkdown("# Title\n<script>alert(1)</script>\n[x](javascript:alert(1))");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.doesNotMatch(html, /<script|javascript:/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
```

- [ ] **Step 2: Run tests and verify red state**

Run: `npx tsx --test tests/safe-markdown.test.ts tests/smoke.test.ts`

Expected: FAIL because the safe renderer and drawer controls do not exist.

- [ ] **Step 3: Implement an escaped local Markdown subset**

In `web/safe-markdown.js`, escape source text before applying structure. Support paragraphs, `#` through `###` headings, unordered/ordered lists, fenced code blocks, inline code, emphasis, and `http:`/`https:` links. Do not support raw HTML, images, iframes, data URLs, or embedded media. Return strings only; never assign untrusted values outside the returned sanitized markup.

Export:

```js
export function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderInline(value) {
  const pattern = /(`[^`]+`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let html = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    html += escapeHtml(value.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) html += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    else if (match[2] != null && match[3] != null) {
      const url = safeExternalUrl(match[3]);
      html += url == null ? escapeHtml(match[2]) : `<a href="${escapeHtml(url)}" data-external-url="${escapeHtml(url)}">${escapeHtml(match[2])}</a>`;
    } else if (match[4] != null) html += `<strong>${escapeHtml(match[4])}</strong>`;
    else html += `<em>${escapeHtml(match[5])}</em>`;
    cursor = match.index + token.length;
  }
  return html + escapeHtml(value.slice(cursor));
}

export function renderSafeMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = [];
  let listTag = null;
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) output.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length > 0 && listTag != null) {
      output.push(`<${listTag}>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${listTag}>`);
    }
    list = [];
    listTag = null;
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (code == null) code = [];
      else {
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      }
      continue;
    }
    if (code != null) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (heading != null) {
      flushParagraph();
      flushList();
      output.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
    } else if (unordered != null || ordered != null) {
      flushParagraph();
      const nextListTag = unordered != null ? "ul" : "ol";
      if (listTag != null && listTag !== nextListTag) flushList();
      listTag = nextListTag;
      list.push((unordered ?? ordered)[1]);
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  if (code != null) output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return output.join("\n");
}
```

Route every link target through `safeExternalUrl()`; tests define the complete supported syntax and emitted tags.

- [ ] **Step 4: Add the temporary drawer shell**

Add one hidden `aside#pr-context-drawer` adjacent to the existing checkout drawer. It must be `position: fixed`/overlay within the native window, not a grid column. Add:

- Top-bar PR title disclosure with chevron.
- Unresolved-thread count button.
- Overview and Threads tab controls.
- `Open / All` segmented filter.
- Refresh icon with tooltip and `aria-label`.
- Last-synced text and close button.

Reuse the checkout drawer’s width constraints, focus trap, and `Escape` pattern, but keep state and element IDs separate so Submit Review cannot open or mutate PR context.

- [ ] **Step 5: Render minimal Overview and thread index**

Overview shows title, author, branches, state, description, and `Open on GitHub`. Threads rows show author/time, path/line, one-line preview, reply count, and only applicable status labels.

Default filter logic:

```js
const openThreads = context.threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
const allItems = [...context.threads, ...context.reviews, ...context.conversationComments];
```

On refresh failure, retain cached rows and show one compact stale line plus retry. Do not add a progress card.

- [ ] **Step 6: Add keyboard and focus behavior**

Add `Open PR context` to the command palette and `P` to `getKeyboardActions()`. Ignore it while an input, textarea, select, or Monaco text editor owns focus. On close, restore the exact opener. Make `Escape` close context before it triggers review cancellation.

- [ ] **Step 7: Run focused tests**

Run: `npx tsx --test tests/safe-markdown.test.ts tests/smoke.test.ts tests/review-navigation-state.test.ts`

Expected: PASS with no permanent diff-width change.

- [ ] **Step 8: Commit**

```bash
git add web/safe-markdown.js web/index.html web/app.js web/review.css tests/safe-markdown.test.ts tests/smoke.test.ts tests/review-navigation-state.test.ts
git commit -m "feat: add focused PR context drawer"
```

---

### Task 5: Render and navigate exact existing GitHub threads inline

**Files:**
- Create: `web/github-review-context.js`
- Create: `tests/github-review-context-renderer.test.ts`
- Modify: `web/app.js`
- Modify: `web/review.css`
- Test: `tests/review-disclosure-state.test.ts`
- Test: `tests/smoke.test.ts`

- [ ] **Step 1: Write failing selector, anchor, and disclosure tests**

Cover unresolved current threads, resolved filtering, outdated threads, head mismatch, missing files, duplicate paths, LEFT/RIGHT sides, lines beyond model length, multiple threads in one file, default-expanded state, explicit independent collapse, and exact selected-thread navigation.

```ts
test("only an exact current GitHub thread receives an inline anchor", () => {
  assert.deepEqual(resolveInlineThread(currentThread, exactContext), {
    fileId: "file-1",
    side: "modified",
    line: 84,
  });
  assert.equal(resolveInlineThread({ ...currentThread, isOutdated: true }, exactContext), null);
  assert.equal(resolveInlineThread(currentThread, { ...exactContext, reviewedHeadSha: "other" }), null);
});

test("thread disclosures start expanded and collapse independently", () => {
  const state = createGitHubThreadDisclosureState();
  assert.equal(state.isExpanded("thread-a"), true);
  state.collapse("thread-a");
  assert.equal(state.isExpanded("thread-a"), false);
  assert.equal(state.isExpanded("thread-b"), true);
});
```

- [ ] **Step 2: Run tests and verify red state**

Run: `npx tsx --test tests/github-review-context-renderer.test.ts tests/review-disclosure-state.test.ts`

Expected: FAIL because the renderer helper module and imported-thread disclosures are absent.

- [ ] **Step 3: Implement pure selectors and disclosure state**

Export from `web/github-review-context.js`:

```js
export function unresolvedThreadCount(context) {
  return (context?.threads ?? []).filter((thread) => !thread.isResolved && !thread.isOutdated).length;
}

export function threadItemsForFilter(context, filter) {
  const threads = context?.threads ?? [];
  if (filter === "open") {
    return threads
      .filter((thread) => !thread.isResolved && !thread.isOutdated)
      .map((item) => ({ kind: "thread", item }));
  }
  return [
    ...threads.map((item) => ({ kind: "thread", item })),
    ...(context?.reviews ?? []).map((item) => ({ kind: "review", item })),
    ...(context?.conversationComments ?? []).map((item) => ({ kind: "conversation", item })),
  ];
}

export function locateCurrentThread(thread, options) {
  if (thread.isOutdated || options.context.reviewedHeadSha !== options.context.remoteHeadSha) return null;
  if (thread.side == null || !Number.isInteger(thread.line) || thread.line < 1) return null;
  const files = options.filesByPath.get(thread.path) ?? [];
  if (files.length !== 1) return null;
  const lineCount = thread.side === "original" ? options.originalLineCount : options.modifiedLineCount;
  if (thread.line > lineCount) return null;
  return { fileId: files[0].id, side: thread.side, line: thread.line };
}

export function createGitHubThreadDisclosureState() {
  const collapsed = new Set();
  return {
    isExpanded: (id) => !collapsed.has(id),
    collapse: (id) => collapsed.add(id),
    expand: (id) => collapsed.delete(id),
  };
}
```

`locateCurrentThread()` must require one unique focused file path match, matching `reviewedHeadSha` and `remoteHeadSha`, non-outdated state, non-null side, and a positive line within the loaded original/modified Monaco model. It returns `null` for every uncertain case.

- [ ] **Step 4: Add read-only Monaco widgets**

Render imported threads in separate view-zone bookkeeping from local comments and AI findings. Each expanded widget shows the ordered conversation, author/time, and `View on GitHub`. It exposes only Collapse/Expand; no Edit, Delete, Stage, Dismiss, Reply, or Resolve actions.

Use the existing published-comment color family but distinct class names:

```css
.review-github-thread-glyph { border: 2px solid #6e7681; border-radius: 50%; background: transparent; }
.review-github-thread-rail { border-left: 2px solid #6e7681; }
.review-github-thread-pulse { animation: github-thread-pulse 700ms ease-out; }
```

Do not insert imported records into `state.comments`, `getDraftComments()`, session serialization, checkout metrics, or publish payload construction.

- [ ] **Step 5: Wire drawer-to-diff navigation**

On current thread selection:

1. Close the context drawer.
2. Open the exact file and Git diff scope.
3. Wait for the requested Monaco models to become active.
4. Validate the side and model line count again.
5. Expand only the selected thread if collapsed.
6. Reveal the line centered and pulse only its widget.

If validation fails after load, reopen the drawer with `Location unavailable`; do not navigate nearby.

- [ ] **Step 6: Run focused tests**

Run: `npx tsx --test tests/github-review-context-renderer.test.ts tests/review-disclosure-state.test.ts tests/smoke.test.ts`

Expected: PASS, including multiple independent threads in one file.

- [ ] **Step 7: Commit**

```bash
git add web/github-review-context.js web/app.js web/review.css tests/github-review-context-renderer.test.ts tests/review-disclosure-state.test.ts tests/smoke.test.ts
git commit -m "feat: show existing GitHub threads inline"
```

---

### Task 6: Harden races, failures, and source isolation

**Files:**
- Modify: `src/github-review-context.ts`
- Modify: `src/index.ts`
- Modify: `src/session-store.ts`
- Modify: `web/app.js`
- Test: `tests/github-review-context.test.ts`
- Test: `tests/publish-lifecycle.test.ts`
- Test: `tests/session-store.test.ts`
- Test: `tests/renderer-protocol.test.ts`

- [ ] **Step 1: Add failing adversarial tests**

Add cases for `gh auth` failure, invalid JSON, repeated cursors, oversized collections, refresh success racing a renderer autosave, refresh success racing GitHub publication, stale cache from another PR/head, refresh after close, local diff sources requesting refresh, and imported IDs colliding with local comment IDs.

```ts
test("renderer autosave cannot erase a concurrently refreshed GitHub context", async () => {
  const saved = await raceRendererCheckpointWithContextRefresh();
  assert.deepEqual(saved.snapshot.githubContext, githubContextSnapshot());
  assert.deepEqual(saved.snapshot.comments, [localComment]);
});

test("imported GitHub records never appear in a publish plan", () => {
  const plan = buildPublishPlanWithContext(githubContextSnapshot());
  assert.deepEqual(plan.representedCommentIds, ["local-comment"]);
});
```

- [ ] **Step 2: Run tests and verify red state**

Run: `npx tsx --test tests/github-review-context.test.ts tests/publish-lifecycle.test.ts tests/session-store.test.ts tests/renderer-protocol.test.ts`

Expected: At least the concurrency and source-isolation cases FAIL before hardening.

- [ ] **Step 3: Make refresh persistence CAS-safe**

Merge a completed refresh into the latest host snapshot inside the same queued persistence chain used by renderer saves. Never save a refresh result from a captured stale snapshot. Preserve `githubPublishIntent`, authoritative published local comments, AI analysis, and the latest renderer checkpoint.

When owner/repo/PR/head do not match, discard the cache before bootstrap. Reject refresh requests for non-GitHub sources in the authenticated host dispatcher.

- [ ] **Step 4: Bound and sanitize failures**

Cap diagnostics at 100 entries and each diagnostic at 500 characters. Convert `gh` failures into these renderer-safe categories:

- `GitHub authentication is required. Run gh auth login.`
- `GitHub review context could not be loaded.`
- `GitHub returned incomplete review context.`

Retain full command diagnostics only in the host-side thrown error/cause path; never send tokens, headers, raw GraphQL payloads, or stderr to the renderer.

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test tests/github-review-context.test.ts tests/publish-lifecycle.test.ts tests/session-store.test.ts tests/renderer-protocol.test.ts`

Expected: PASS with imported context absent from all publish assertions.

- [ ] **Step 6: Commit**

```bash
git add src/github-review-context.ts src/index.ts src/session-store.ts web/app.js tests/github-review-context.test.ts tests/publish-lifecycle.test.ts tests/session-store.test.ts tests/renderer-protocol.test.ts
git commit -m "fix: harden GitHub context synchronization"
```

---

### Task 7: Verify the complete workflow on a real PR

**Files:**
- Modify: `README.md`
- Modify: `tests/smoke.test.ts`

- [ ] **Step 1: Document the focused workflow**

Add a concise README section stating that GitHub PR reviews show the PR description and existing threads, context refreshes asynchronously, imported threads are read-only, and only local staged comments are submitted.

- [ ] **Step 2: Add final static workflow assertions**

Extend `tests/smoke.test.ts` to assert:

```ts
assert.equal(appJs.includes("Open PR context"), true);
assert.equal(appJs.includes("refresh-github-context"), true);
assert.equal(appJs.includes("state.comments.push(githubThread"), false);
assert.equal(html.includes('id="pr-context-drawer"'), true);
```

- [ ] **Step 3: Run the full automated verification**

Run:

```bash
npm test
npm run check
npm run build:web
git diff --check
```

Expected: all tests pass, TypeScript emits no errors, the web bundle builds, and whitespace validation is clean.

- [ ] **Step 4: Run the real PR #664 acceptance pass**

Run:

```bash
pi-diff-review --reset-review pr https://github.com/headout/magellan/pull/664
```

Verify manually:

- The diff is usable before context refresh completes.
- The top-bar title opens Overview and renders the actual PR description.
- The unresolved count matches GitHub.
- Existing unresolved threads in at least one changed file are expanded at the same lines as GitHub.
- Selecting a thread closes the drawer, centers the exact line, and pulses one thread.
- `All` reveals resolved/outdated/general comments without attaching outdated threads.
- Local staged count and Submit Review payload exclude imported threads.
- Closing and reopening restores cached context immediately and refreshes quietly.

- [ ] **Step 5: Commit documentation and final assertions**

```bash
git add README.md tests/smoke.test.ts
git commit -m "docs: explain GitHub review context workflow"
```

- [ ] **Step 6: Review the complete branch diff**

Run:

```bash
git status --short
git diff main...HEAD --stat
git log --show-signature --oneline main..HEAD
```

Expected: only the planned feature files changed, the worktree is clean, and every new commit has a valid signature.
