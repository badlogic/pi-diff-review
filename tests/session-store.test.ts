import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import * as sessionStore from "../src/session-store.js";
import { createFallbackAnalysis } from "../src/analysis.js";
import { runReviewSessionStartupPersistence } from "../src/review-session-startup.js";
import {
  buildReviewDiffFingerprint,
  buildReviewSessionRecord,
  loadReviewSession,
  resolveReviewSession,
  resetReviewSession,
  saveReviewSession,
} from "../src/session-store.js";
import type { ReviewDataset } from "../src/sources/types.js";
import type {
  DiffReviewComment,
  GitHubReviewPublishIntent,
  ReviewFile,
  ReviewSessionSnapshot,
} from "../src/types.js";

interface PublishSessionController {
  readonly intent: Record<string, any> | null;
  mergeSnapshot(snapshot: ReviewSessionSnapshot): ReviewSessionSnapshot;
  runPublish(
    options: {
      correlationId: string;
      snapshot: ReviewSessionSnapshot;
      representedCommentIds: string[];
      submittedComments: DiffReviewComment[];
    },
    publishRemote: (beforePost: () => Promise<void>) => Promise<{
      reviewId?: number;
      reviewUrl?: string;
      submittedAt?: string;
      warnings: string[];
    }>,
  ): Promise<unknown>;
  reconcileOutstanding(
    reconcileRemote: (intent: Record<string, any>) => Promise<{
      reviewId?: number;
      reviewUrl?: string;
      submittedAt?: string;
      warnings: string[];
    } | null>,
  ): Promise<{ status: string; receipt?: unknown; warning?: string }>;
  abandonOutstanding(): Promise<{ status: string; warning?: string }>;
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await delay(5);
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for process ${pid} to exit`);
    await delay(5);
  }
}

const publishSource = {
  sourceKey: "github:headout/magellan:pull/646",
  owner: "headout",
  repo: "magellan",
  pullNumber: 646,
  reviewedBaseSha: "base-immutable-sha",
  reviewedHeadSha: "head-immutable-sha",
};

function stagedComment(id = "submitted"): DiffReviewComment {
  return {
    id,
    fileId: "src/app/api/qa_api.py",
    scope: "git-diff",
    side: "modified",
    startLine: 1,
    endLine: 1,
    body: "Submitted body.",
  };
}

function githubContextSnapshot() {
  return {
    owner: "headout",
    repo: "magellan",
    pullNumber: 646,
    reviewedHeadSha: "head-immutable-sha",
    remoteHeadSha: "head-immutable-sha",
    fetchedAt: "2026-07-10T12:00:00Z",
    conversationComments: [{
      id: "conversation-1",
      author: "reviewer",
      body: "General context.",
      createdAt: "2026-07-10T10:00:00Z",
      url: "https://github.com/headout/magellan/pull/646#issuecomment-1",
    }],
    reviews: [],
    threads: [{
      id: "thread-1",
      isResolved: false,
      isOutdated: false,
      path: "src/app/api/qa_api.py",
      side: "modified",
      line: 1,
      originalLine: null,
      comments: [{
        id: "thread-comment-1",
        author: "reviewer",
        body: "Please guard this path.",
        createdAt: "2026-07-10T10:05:00Z",
        url: "https://github.com/headout/magellan/pull/646#discussion_r1",
      }],
    }],
    diagnostics: [],
  };
}

function createPublishHarness(options: {
  snapshot?: ReviewSessionSnapshot;
  initialIntent?: Record<string, unknown> | null;
  persist?: (snapshot: ReviewSessionSnapshot) => Promise<boolean>;
  source?: typeof publishSource;
} = {}) {
  const createController = (sessionStore as Record<string, unknown>).createGitHubPublishSessionController;
  assert.equal(typeof createController, "function");
  let latest = options.snapshot ?? { comments: [stagedComment()] };
  let recordRevision = 0;
  let recordState: { revision: number; recordHash: string } | null = null;
  const saved: ReviewSessionSnapshot[] = [];
  const persist = options.persist ?? (async (snapshot: ReviewSessionSnapshot) => {
    latest = snapshot;
    saved.push(structuredClone(snapshot));
    return true;
  });
  const controller = (createController as (options: Record<string, unknown>) => PublishSessionController)({
    source: options.source ?? publishSource,
    initialIntent: options.initialIntent ?? latest.githubPublishIntent ?? null,
    getSnapshot: () => latest,
    getRecordState: () => recordState,
    persistSnapshot: async (snapshot: ReviewSessionSnapshot) => {
      const ok = await persist(snapshot);
      if (ok) {
        latest = snapshot;
        recordRevision += 1;
        recordState = { revision: recordRevision, recordHash: recordRevision.toString(16).padStart(64, "0") };
      }
      return ok;
    },
    now: () => "2026-07-10T09:00:00Z",
  });
  return {
    controller,
    saved,
    latest: () => latest,
    setLatest: (snapshot: ReviewSessionSnapshot) => { latest = snapshot; },
  };
}

function mockPi() {
  return {
    exec: async (_command: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[2] === "HEAD") {
        return { code: 0, stdout: "base-sha\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  };
}

function dataset(paths: string[]): ReviewDataset {
  return {
    repoRoot: "/repo",
    workingRoot: "/repo",
    commits: [],
    analysisFileIds: paths,
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
        commentableOriginalLines: [{ start: 1, end: 1 }],
        commentableModifiedLines: [{ start: 1, end: 2 }],
      },
      lastCommit: null,
      commitComparisons: {},
    })),
  };
}

interface ReconciliationFileSpec {
  id: string;
  path: string;
  patch: string;
  originalRanges?: Array<{ start: number; end: number }>;
  modifiedRanges?: Array<{ start: number; end: number }>;
}

function reconciliationDataset(specs: ReconciliationFileSpec[]): ReviewDataset {
  return {
    ...dataset([]),
    commits: [{ sha: "commit-valid", shortSha: "commit-v", subject: "Valid commit" }],
    analysisFileIds: specs.map((spec) => spec.id),
    files: specs.map((spec): ReviewFile => ({
      id: spec.id,
      path: spec.path,
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: true,
      gitDiff: {
        status: "modified",
        oldPath: spec.path,
        newPath: spec.path,
        displayPath: spec.path,
        hasOriginal: true,
        hasModified: true,
        commentableOriginalLines: spec.originalRanges ?? [{ start: 1, end: 3 }],
        commentableModifiedLines: spec.modifiedRanges ?? [{ start: 1, end: 3 }],
      },
      lastCommit: {
        status: "modified",
        oldPath: spec.path,
        newPath: spec.path,
        displayPath: spec.path,
        hasOriginal: true,
        hasModified: true,
        commentableOriginalLines: spec.originalRanges ?? [{ start: 1, end: 3 }],
        commentableModifiedLines: spec.modifiedRanges ?? [{ start: 1, end: 3 }],
      },
      commitComparisons: {
        "commit-valid": {
          status: "modified",
          oldPath: spec.path,
          newPath: spec.path,
          displayPath: spec.path,
          hasOriginal: true,
          hasModified: true,
          commentableOriginalLines: spec.originalRanges ?? [{ start: 1, end: 3 }],
          commentableModifiedLines: spec.modifiedRanges ?? [{ start: 1, end: 3 }],
        },
      },
    })),
  };
}

async function reconciliationFingerprint(reviewDataset: ReviewDataset, specs: ReconciliationFileSpec[]) {
  const patchById = new Map(specs.map((spec) => [spec.id, spec.patch]));
  return await buildReviewDiffFingerprint(
    mockPi() as never,
    reviewDataset,
    async (file) => patchById.get(file.id) ?? "",
  );
}

function reconciliationComment(options: {
  id: string;
  fileId: string;
  startLine?: number;
  endLine?: number | null;
  scope?: DiffReviewComment["scope"];
  commitSha?: string;
  published?: boolean;
}): DiffReviewComment {
  const publishedAt = "2026-07-10T09:30:00Z";
  return {
    id: options.id,
    fileId: options.fileId,
    scope: options.scope ?? "git-diff",
    ...(options.scope === "commit" ? { commitSha: options.commitSha ?? "commit-valid" } : {}),
    side: "modified",
    startLine: options.startLine ?? 1,
    endLine: options.endLine ?? options.startLine ?? 1,
    body: `Body for ${options.id}`,
    ...(options.published
      ? {
          status: "published" as const,
          published: true,
          publishedAt,
          githubReviewId: 4321,
          githubReviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
        }
      : {}),
  };
}

test("diff fingerprint is stable for the same patches and changes when patches change", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const first = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:one`);
  const second = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:one`);
  const changed = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:two`);

  assert.equal(first.hash, second.hash);
  assert.notEqual(first.hash, changed.hash);
  assert.equal(first.fileCount, 1);
});

test("session resolution restores cached analysis when fingerprint matches", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const stored = buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: {
      analysis,
      overallComment: "remember this",
    },
  });

  const resolution = resolveReviewSession({
    stored,
    sourceKey: fingerprint.sourceKey,
    currentFingerprint: fingerprint,
    dataset: reviewDataset,
  });

  assert.equal(resolution.status, "restored");
  assert.equal(resolution.analysis?.message, "cached");
  assert.equal(resolution.snapshot?.overallComment, "remember this");
});

test("matching sessions persist and restore host-owned GitHub review context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-context-"));
  const storagePath = join(root, "session.json");
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const context = githubContextSnapshot();
  const record = buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { analysis, githubContext: context } as never,
  });
  await saveReviewSession(storagePath, record);
  const stored = await loadReviewSession(storagePath);
  assert.ok(stored);

  const resolution = resolveReviewSession({ stored, sourceKey: fingerprint.sourceKey, currentFingerprint: fingerprint, dataset: reviewDataset });

  assert.deepEqual((resolution.snapshot as Record<string, unknown>)?.githubContext, context);
  await rm(root, { recursive: true, force: true });
});

test("stale sessions drop cached GitHub review context", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const oldFingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async () => "old");
  const currentFingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async () => "new");
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const stored = buildReviewSessionRecord({
    sourceKey: oldFingerprint.sourceKey,
    fingerprint: oldFingerprint,
    analysis,
    snapshot: { analysis, githubContext: githubContextSnapshot() } as never,
  });

  const resolution = resolveReviewSession({ stored, sourceKey: currentFingerprint.sourceKey, currentFingerprint, dataset: reviewDataset });

  assert.equal((resolution.snapshot as Record<string, unknown>)?.githubContext, undefined);
});

test("session resolution drops changed-file state when fingerprint changes", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const oldFingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:old`);
  const newFingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:new`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const stored = buildReviewSessionRecord({
    sourceKey: oldFingerprint.sourceKey,
    fingerprint: oldFingerprint,
    analysis,
    snapshot: {
      analysis,
      comments: [{
        id: "comment-1",
        fileId: "src/app/api/qa_api.py",
        scope: "git-diff",
        side: "modified",
        startLine: 1,
        endLine: 1,
        body: "keep this draft",
      }],
    },
  });

  const resolution = resolveReviewSession({
    stored,
    sourceKey: newFingerprint.sourceKey,
    currentFingerprint: newFingerprint,
    dataset: reviewDataset,
  });

  assert.equal(resolution.status, "stale");
  assert.equal(resolution.analysis, null);
  assert.deepEqual(resolution.snapshot?.comments, []);
});

test("a changed fingerprint archives the prior validated session before replacement", async () => {
  const recoveryPathFor = (sessionStore as Record<string, unknown>).reviewSessionRecoveryPath;
  assert.equal(typeof recoveryPathFor, "function");
  if (typeof recoveryPathFor !== "function") return;
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const oldFingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:old`);
  const newFingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:new`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-recovery-"));
  const storagePath = join(root, "session.json");
  const original = await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: oldFingerprint.sourceKey,
    fingerprint: oldFingerprint,
    analysis,
    snapshot: { comments: [stagedComment("recover-me")] },
  }));
  const recoveryPath = (recoveryPathFor as (path: string, record: typeof original) => string)(storagePath, original);

  await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: newFingerprint.sourceKey,
    fingerprint: newFingerprint,
    analysis,
    snapshot: { comments: [] },
  }), { expectedRecordState: sessionStore.reviewSessionRecordState(original) });

  assert.equal(existsSync(recoveryPath), true);
  const recovered = await loadReviewSession(recoveryPath);
  assert.equal(recovered?.fingerprint.hash, oldFingerprint.hash);
  assert.deepEqual(recovered?.snapshot.comments?.map((comment) => comment.id), ["recover-me"]);
  assert.equal((await loadReviewSession(storagePath))?.fingerprint.hash, newFingerprint.hash);
});

test("stale reconciliation remaps only unchanged patches and clears every generated state field", async () => {
  const oldSpecs: ReconciliationFileSpec[] = [
    { id: "old:unchanged", path: "src/unchanged.ts", patch: "same", modifiedRanges: [{ start: 1, end: 3 }] },
    { id: "old:changed", path: "src/changed.ts", patch: "old changed" },
    { id: "old:removed", path: "src/removed.ts", patch: "removed" },
    { id: "old:renamed", path: "src/before.ts", patch: "rename patch" },
  ];
  const currentSpecs: ReconciliationFileSpec[] = [
    { id: "current:unchanged", path: "src/unchanged.ts", patch: "same", modifiedRanges: [{ start: 1, end: 2 }] },
    { id: "current:changed", path: "src/changed.ts", patch: "new changed" },
    { id: "current:renamed", path: "src/after.ts", patch: "rename patch" },
  ];
  const oldDataset = reconciliationDataset(oldSpecs);
  const currentDataset = reconciliationDataset(currentSpecs);
  const oldFingerprint = await reconciliationFingerprint(oldDataset, oldSpecs);
  const currentFingerprint = await reconciliationFingerprint(currentDataset, currentSpecs);
  const oldAnalysis = createFallbackAnalysis(oldDataset, "cached");
  const retainedPublished = reconciliationComment({
    id: "published-unchanged",
    fileId: "old:unchanged",
    startLine: 2,
    published: true,
  });
  const stored = buildReviewSessionRecord({
    sourceKey: oldFingerprint.sourceKey,
    fingerprint: oldFingerprint,
    analysis: oldAnalysis,
    snapshot: {
      analysis: oldAnalysis,
      overallComment: "Keep the overall review note.",
      comments: [
        reconciliationComment({ id: "draft-unchanged", fileId: "old:unchanged", endLine: 2 }),
        retainedPublished,
        reconciliationComment({ id: "changed", fileId: "old:changed" }),
        reconciliationComment({ id: "removed", fileId: "old:removed" }),
        reconciliationComment({ id: "renamed", fileId: "old:renamed" }),
        reconciliationComment({ id: "invalid-range", fileId: "old:unchanged", startLine: 3 }),
      ],
      reviewedFiles: {
        "old:unchanged": true,
        "old:changed": true,
        "old:removed": true,
        "old:renamed": true,
      },
      activeFileId: "old:unchanged",
      activeInsight: { type: "comment", id: "draft-unchanged" },
      activeSidebarTab: "findings",
      currentScope: "commit",
      selectedCommitSha: "commit-valid",
      hideUnchanged: true,
      wrapLines: false,
      sidebarCollapsed: true,
      reviewedChapters: { "chapter-old": true },
      acceptedFindingComments: { "finding-old": "Accept this comment." },
      findingStatuses: { "finding-old": "accepted-comment" },
      dismissedFindingLocationKeys: ["finding-old:src/unchanged.ts:modified:1"],
      aiReviewCompleted: true,
      aiReviewStatus: "done",
    },
  });

  const resolution = resolveReviewSession({
    stored,
    sourceKey: currentFingerprint.sourceKey,
    currentFingerprint,
    dataset: currentDataset,
  });

  assert.equal(resolution.status, "stale");
  assert.equal(resolution.analysis, null);
  assert.deepEqual(resolution.reconciliation, {
    previousFileCount: 4,
    currentFileCount: 3,
    unchangedFileCount: 1,
    retainedCommentCount: 2,
    droppedCommentCount: 4,
    retainedReviewedFileCount: 1,
    droppedReviewedFileCount: 3,
  });
  assert.match(resolution.message, /1 unchanged file.*2 comments.*4 dropped/i);
  assert.deepEqual(resolution.snapshot, {
    overallComment: "Keep the overall review note.",
    comments: [
      { ...reconciliationComment({ id: "draft-unchanged", fileId: "old:unchanged", endLine: 2 }), fileId: "current:unchanged" },
      { ...retainedPublished, fileId: "current:unchanged" },
    ],
    reviewedFiles: { "current:unchanged": true },
    activeFileId: "current:unchanged",
    activeInsight: { type: "comment", id: "draft-unchanged" },
    activeSidebarTab: "findings",
    currentScope: "commit",
    selectedCommitSha: "commit-valid",
    hideUnchanged: true,
    wrapLines: false,
    sidebarCollapsed: true,
  });

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-reconciled-valid-"));
  const persisted = await saveReviewSession(join(root, "session.json"), buildReviewSessionRecord({
    sourceKey: currentFingerprint.sourceKey,
    fingerprint: currentFingerprint,
    analysis: createFallbackAnalysis(currentDataset, "fresh"),
    snapshot: resolution.snapshot,
  }));
  assert.equal((await loadReviewSession(join(root, "session.json")))?.recordHash, persisted.recordHash);
});

test("stale reconciliation clears active targets and invalid global selectors that no longer exist", async () => {
  const oldSpecs = [{ id: "old:file", path: "src/file.ts", patch: "same" }];
  const currentSpecs = [{ id: "current:file", path: "src/file.ts", patch: "same" }];
  const oldDataset = reconciliationDataset(oldSpecs);
  const currentDataset = reconciliationDataset(currentSpecs);
  currentDataset.commits = [];
  currentDataset.files[0].inLastCommit = false;
  currentDataset.files[0].lastCommit = null;
  currentDataset.files[0].commitComparisons = {};
  const oldFingerprint = await reconciliationFingerprint(oldDataset, oldSpecs);
  const currentFingerprint = await reconciliationFingerprint(currentDataset, currentSpecs);
  const analysis = createFallbackAnalysis(oldDataset, "cached");
  const stored = buildReviewSessionRecord({
    sourceKey: oldFingerprint.sourceKey,
    fingerprint: oldFingerprint,
    analysis,
    snapshot: {
      comments: [reconciliationComment({ id: "invalid", fileId: "old:file", startLine: 99 })],
      activeFileId: "old:file",
      activeInsight: { type: "comment", id: "invalid" },
      currentScope: "commit",
      selectedCommitSha: "commit-valid",
    },
  });

  const resolution = resolveReviewSession({
    stored,
    sourceKey: currentFingerprint.sourceKey,
    currentFingerprint,
    dataset: currentDataset,
  });

  assert.deepEqual(resolution.snapshot, {
    comments: [],
    activeFileId: "current:file",
  });
  assert.deepEqual(resolution.reconciliation, {
    previousFileCount: 1,
    currentFileCount: 1,
    unchangedFileCount: 1,
    retainedCommentCount: 0,
    droppedCommentCount: 1,
    retainedReviewedFileCount: 0,
    droppedReviewedFileCount: 0,
  });
});

test("stale reconciliation counts only true reviewed-file entries", async () => {
  const oldSpecs = [
    { id: "old:reviewed", path: "src/reviewed.ts", patch: "same reviewed" },
    { id: "old:unreviewed", path: "src/unreviewed.ts", patch: "same unreviewed" },
    { id: "old:dropped-reviewed", path: "src/changed.ts", patch: "before" },
    { id: "old:dropped-unreviewed", path: "src/removed.ts", patch: "removed" },
  ];
  const currentSpecs = [
    { id: "current:reviewed", path: "src/reviewed.ts", patch: "same reviewed" },
    { id: "current:unreviewed", path: "src/unreviewed.ts", patch: "same unreviewed" },
    { id: "current:changed", path: "src/changed.ts", patch: "after" },
  ];
  const oldDataset = reconciliationDataset(oldSpecs);
  const currentDataset = reconciliationDataset(currentSpecs);
  const oldFingerprint = await reconciliationFingerprint(oldDataset, oldSpecs);
  const currentFingerprint = await reconciliationFingerprint(currentDataset, currentSpecs);
  const analysis = createFallbackAnalysis(oldDataset, "cached");
  const stored = buildReviewSessionRecord({
    sourceKey: oldFingerprint.sourceKey,
    fingerprint: oldFingerprint,
    analysis,
    snapshot: {
      reviewedFiles: {
        "old:reviewed": true,
        "old:unreviewed": false,
        "old:dropped-reviewed": true,
        "old:dropped-unreviewed": false,
      },
    },
  });

  const resolution = resolveReviewSession({
    stored,
    sourceKey: currentFingerprint.sourceKey,
    currentFingerprint,
    dataset: currentDataset,
  });

  assert.deepEqual(resolution.snapshot?.reviewedFiles, {
    "current:reviewed": true,
    "current:unreviewed": false,
  });
  assert.equal(resolution.reconciliation?.retainedReviewedFileCount, 1);
  assert.equal(resolution.reconciliation?.droppedReviewedFileCount, 1);
  assert.match(resolution.message, /1 reviewed file.*1 dropped/i);
});

test("stale reconciliation preserves pending and ambiguous publish intent exactly", async (t) => {
  for (const status of ["pending", "ambiguous"] as const) {
    await t.test(status, async () => {
      const oldSpecs = [{ id: "old:file", path: "src/file.ts", patch: "before" }];
      const currentSpecs = [{ id: "current:file", path: "src/file.ts", patch: "after" }];
      const oldDataset = reconciliationDataset(oldSpecs);
      const currentDataset = reconciliationDataset(currentSpecs);
      const oldFingerprint = await reconciliationFingerprint(oldDataset, oldSpecs);
      const currentFingerprint = await reconciliationFingerprint(currentDataset, currentSpecs);
      const analysis = createFallbackAnalysis(oldDataset, "cached");
      const intent: GitHubReviewPublishIntent = {
        version: 1,
        status,
        correlationId: `review-intent-stale-${status}`,
        source: { ...publishSource, sourceKey: oldFingerprint.sourceKey, reviewedHeadSha: "old-head" },
        representedCommentIds: ["submitted-old"],
        submittedComments: [reconciliationComment({ id: "submitted-old", fileId: "old:file" })],
        createdAt: "2026-07-10T09:00:00Z",
        updatedAt: "2026-07-10T09:01:00Z",
        ...(status === "ambiguous" ? { lastError: "The POST result is unknown." } : {}),
      };
      const root = await mkdtemp(join(tmpdir(), `pi-diff-review-stale-${status}-`));
      const storagePath = join(root, "session.json");
      const stored = await saveReviewSession(storagePath, buildReviewSessionRecord({
        sourceKey: oldFingerprint.sourceKey,
        fingerprint: oldFingerprint,
        analysis,
        snapshot: {
          comments: [reconciliationComment({ id: "submitted-old", fileId: "old:file" })],
          githubPublishIntent: intent,
        },
      }), {
        expectedRecordState: null,
        publishIntentTransition: {
          expected: null,
          next: intent,
          expectedRecordState: null,
        },
      });

      const resolution = resolveReviewSession({
        stored,
        sourceKey: currentFingerprint.sourceKey,
        currentFingerprint,
        dataset: currentDataset,
      });

      assert.deepEqual(resolution.snapshot?.comments, []);
      assert.deepEqual(resolution.snapshot?.githubPublishIntent, intent);
      assert.equal(resolution.confirmedPublishIntentToRetire, null);

      const persisted = await saveReviewSession(storagePath, buildReviewSessionRecord({
        sourceKey: currentFingerprint.sourceKey,
        fingerprint: currentFingerprint,
        analysis: createFallbackAnalysis(currentDataset, "fresh"),
        snapshot: resolution.snapshot,
      }), {
        expectedRecordState: { revision: stored.revision, recordHash: stored.recordHash },
      });
      assert.deepEqual(persisted.snapshot.githubPublishIntent, intent);
      assert.deepEqual((await loadReviewSession(storagePath))?.snapshot.githubPublishIntent, intent);
    });
  }
});

test("confirmed stale intent retires through CAS before the first ordinary startup save", async () => {
  const oldSpecs = [
    { id: "old:unchanged", path: "src/unchanged.ts", patch: "same" },
    { id: "old:changed", path: "src/changed.ts", patch: "before" },
  ];
  const currentSpecs = [
    { id: "current:unchanged", path: "src/unchanged.ts", patch: "same" },
    { id: "current:changed", path: "src/changed.ts", patch: "after" },
  ];
  const oldDataset = reconciliationDataset(oldSpecs);
  const currentDataset = reconciliationDataset(currentSpecs);
  const oldFingerprint = await reconciliationFingerprint(oldDataset, oldSpecs);
  const currentFingerprint = await reconciliationFingerprint(currentDataset, currentSpecs);
  const oldAnalysis = createFallbackAnalysis(oldDataset, "cached");
  const submittedUnchanged = reconciliationComment({ id: "submitted-unchanged", fileId: "old:unchanged" });
  const submittedChanged = reconciliationComment({ id: "submitted-changed", fileId: "old:changed" });
  const confirmed: GitHubReviewPublishIntent = {
    version: 1,
    status: "confirmed",
    correlationId: "review-intent-confirmed-stale-head",
    source: { ...publishSource, sourceKey: oldFingerprint.sourceKey, reviewedHeadSha: "old-head" },
    representedCommentIds: [submittedUnchanged.id, submittedChanged.id],
    submittedComments: [submittedUnchanged, submittedChanged],
    createdAt: "2026-07-10T09:00:00Z",
    updatedAt: "2026-07-10T09:30:00Z",
    receipt: {
      reviewId: 4321,
      reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
      submittedAt: "2026-07-10T09:30:00Z",
      warnings: ["already submitted"],
    },
  };
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-confirmed-reconcile-"));
  const storagePath = join(root, "session.json");
  const stored = await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: oldFingerprint.sourceKey,
    fingerprint: oldFingerprint,
    analysis: oldAnalysis,
    snapshot: { githubPublishIntent: confirmed },
  }), {
    expectedRecordState: null,
    publishIntentTransition: {
      expected: null,
      next: confirmed,
      expectedRecordState: null,
    },
  });

  const resolution = resolveReviewSession({
    stored,
    sourceKey: currentFingerprint.sourceKey,
    currentFingerprint,
    dataset: currentDataset,
  });

  assert.deepEqual(resolution.confirmedPublishIntentToRetire, confirmed);
  assert.equal(resolution.snapshot?.githubPublishIntent, undefined);
  assert.deepEqual(resolution.snapshot?.comments, [{
    ...submittedUnchanged,
    fileId: "current:unchanged",
    status: "published",
    published: true,
    publishedAt: "2026-07-10T09:30:00Z",
    githubReviewId: 4321,
    githubReviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
  }]);
  assert.deepEqual(resolution.reconciliation, {
    previousFileCount: 2,
    currentFileCount: 2,
    unchangedFileCount: 1,
    retainedCommentCount: 1,
    droppedCommentCount: 1,
    retainedReviewedFileCount: 0,
    droppedReviewedFileCount: 0,
  });

  const expectedRecordState = { revision: stored.revision, recordHash: stored.recordHash };
  const events: string[] = [];
  let ordinarySaveState = expectedRecordState;
  let persisted = stored;
  await runReviewSessionStartupPersistence({
    confirmedIntent: resolution.confirmedPublishIntentToRetire,
    snapshot: resolution.snapshot,
    recordState: expectedRecordState,
    persistConfirmedRetirement: async (snapshot, transition) => {
      events.push("retire-confirmed");
      persisted = await saveReviewSession(storagePath, buildReviewSessionRecord({
        sourceKey: currentFingerprint.sourceKey,
        fingerprint: currentFingerprint,
        analysis: createFallbackAnalysis(currentDataset, "fresh"),
        snapshot,
      }), {
        expectedRecordState: transition.expectedRecordState,
        publishIntentTransition: transition,
      });
      return persisted;
    },
    initializeRuntime: async (state) => {
      events.push("initialize-runtime");
      const onDisk = await loadReviewSession(storagePath);
      assert.equal(onDisk?.snapshot.githubPublishIntent, undefined);
      assert.equal(onDisk?.revision, stored.revision + 1);
      assert.deepEqual(state.snapshot.comments, resolution.snapshot?.comments);
      ordinarySaveState = state.recordState!;
    },
    persistInitialSnapshot: async (state) => {
      events.push("ordinary-save");
      assert.deepEqual(state.recordState, ordinarySaveState);
      persisted = await saveReviewSession(storagePath, buildReviewSessionRecord({
        sourceKey: currentFingerprint.sourceKey,
        fingerprint: currentFingerprint,
        analysis: createFallbackAnalysis(currentDataset, "fresh"),
        snapshot: state.snapshot,
      }), { expectedRecordState: state.recordState });
      return true;
    },
  });

  assert.deepEqual(events, ["retire-confirmed", "initialize-runtime", "ordinary-save"]);
  assert.equal(persisted.revision, stored.revision + 2);
  assert.equal(persisted.snapshot.githubPublishIntent, undefined);
  assert.deepEqual(persisted.snapshot.comments, resolution.snapshot?.comments);
  await assert.rejects(saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: currentFingerprint.sourceKey,
    fingerprint: currentFingerprint,
    analysis: createFallbackAnalysis(currentDataset, "stale writer"),
    snapshot: resolution.snapshot,
  }), {
    expectedRecordState,
    publishIntentTransition: {
      expected: confirmed,
      next: null,
      expectedRecordState,
    },
  }), /record.*changed|revision|hash|compare/i);
});

test("session resolution refreshes a matching session with invalid cached analysis", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const stored = buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: {
      comments: [reconciliationComment({ id: "safe-comment", fileId: "src/app/api/qa_api.py" })],
      reviewedFiles: { "src/app/api/qa_api.py": true },
      overallComment: "Keep human state.",
      reviewedChapters: { [analysis.chapters[0].id]: true },
      aiReviewCompleted: true,
      aiReviewStatus: "done",
      activeInsight: { type: "chapter", id: analysis.chapters[0].id },
    },
  });
  stored.snapshot.analysis = {
    ...analysis,
    chapters: [{
      ...analysis.chapters[0],
      fileIds: ["not-a-real-file"],
    }],
  };

  const resolution = resolveReviewSession({
    stored,
    sourceKey: fingerprint.sourceKey,
    currentFingerprint: fingerprint,
    dataset: reviewDataset,
  });

  assert.equal(resolution.status, "refreshed");
  assert.equal(resolution.analysis, null);
  assert.deepEqual(resolution.snapshot, {
    comments: [reconciliationComment({ id: "safe-comment", fileId: "src/app/api/qa_api.py" })],
    reviewedFiles: { "src/app/api/qa_api.py": true },
    overallComment: "Keep human state.",
  });
});

test("reset review session removes only the selected review metadata directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-"));
  const selectedPath = join(root, "reviews", "selected", "session.json");
  const siblingPath = join(root, "reviews", "sibling", "session.json");
  await mkdir(join(root, "reviews", "selected"), { recursive: true });
  await mkdir(join(root, "reviews", "sibling"), { recursive: true });
  await writeFile(selectedPath, "selected", "utf8");
  await writeFile(siblingPath, "sibling", "utf8");

  await resetReviewSession(selectedPath);

  assert.equal(existsSync(selectedPath), false);
  assert.equal(existsSync(join(root, "reviews", "selected")), false);
  assert.equal(existsSync(siblingPath), true);
});

test("reset waits for the same per-source transaction used by session saves", async () => {
  const withTransaction = (sessionStore as Record<string, unknown>).withReviewSessionTransaction;
  assert.equal(typeof withTransaction, "function");
  if (typeof withTransaction !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-reset-lock-"));
  const storagePath = join(root, "reviews", "selected", "session.json");
  await mkdir(join(root, "reviews", "selected"), { recursive: true });
  await writeFile(storagePath, "selected", "utf8");
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let entered!: () => void;
  const didEnter = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  const holding = (withTransaction as <T>(path: string, task: () => Promise<T>) => Promise<T>)(storagePath, async () => {
    entered();
    await gate;
  });
  await didEnter;

  let resetFinished = false;
  const resetting = resetReviewSession(storagePath).then(() => { resetFinished = true; });
  await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  assert.equal(resetFinished, false);
  assert.equal(existsSync(storagePath), true);

  release();
  await holding;
  await resetting;
  assert.equal(existsSync(join(root, "reviews", "selected")), false);
});

test("loadReviewSession returns null only for ENOENT and surfaces corrupt, incompatible, and unreadable metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-load-"));
  const missingPath = join(root, "missing.json");
  assert.equal(await loadReviewSession(missingPath), null);

  const corruptPath = join(root, "corrupt.json");
  await writeFile(corruptPath, "{not-json", "utf8");
  await assert.rejects(loadReviewSession(corruptPath), /corrupt|invalid/i);

  const incompatiblePath = join(root, "incompatible.json");
  await writeFile(incompatiblePath, JSON.stringify({ version: 999, sourceKey: "source" }), "utf8");
  await assert.rejects(loadReviewSession(incompatiblePath), /incompatible|invalid/i);

  const loadWithDependencies = loadReviewSession as unknown as (
    path: string,
    dependencies: { readFile: (path: string, encoding: string) => Promise<string> },
  ) => Promise<unknown>;
  const unreadable = Object.assign(new Error("permission denied"), { code: "EACCES" });
  await assert.rejects(loadWithDependencies(join(root, "unreadable.json"), {
    readFile: async () => { throw unreadable; },
  }), (error: unknown) => error instanceof Error
    && /could not read/i.test(error.message)
    && error.cause === unreadable);
});

test("legacy v1 sessions migrate deterministically and upgrade on the next CAS save", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-v1-migration-"));
  const storagePath = join(root, "session.json");
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(
    mockPi() as never,
    reviewDataset,
    async (file) => `patch:${file.path}`,
  );
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const updatedAt = "2026-07-09T12:00:00.000Z";
  const legacy = {
    version: 1,
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    snapshot: {
      analysis,
      overallComment: "Keep this review note.",
      comments: [stagedComment("legacy-comment")],
      reviewedFiles: { "src/app/api/qa_api.py": true },
      updatedAt,
    },
    updatedAt,
  };
  await writeFile(storagePath, JSON.stringify(legacy), "utf8");

  const firstLoad = await loadReviewSession(storagePath);
  const secondLoad = await loadReviewSession(storagePath);
  assert.equal(firstLoad?.version, 2);
  assert.equal(firstLoad?.revision, 0);
  assert.match(firstLoad?.recordHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(secondLoad?.recordHash, firstLoad?.recordHash);
  assert.equal(firstLoad?.snapshot.overallComment, "Keep this review note.");
  assert.deepEqual(firstLoad?.snapshot.comments?.map((item) => item.id), ["legacy-comment"]);
  assert.deepEqual(firstLoad?.snapshot.reviewedFiles, { "src/app/api/qa_api.py": true });

  assert.ok(firstLoad);
  const upgraded = await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: firstLoad.snapshot,
  }), {
    expectedRecordState: { revision: firstLoad.revision, recordHash: firstLoad.recordHash },
  });
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.revision, 1);
  const onDisk = JSON.parse(await readFile(storagePath, "utf8")) as Record<string, unknown>;
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.revision, 1);
  assert.match(String(onDisk.recordHash), /^[a-f0-9]{64}$/);
});

test("loadReviewSession strictly validates the full snapshot and publish state machine", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-invalid-"));
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const validPublishSource = { ...publishSource, sourceKey: fingerprint.sourceKey };
  const validRecord = buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: {
      comments: [{ ...stagedComment(), endLine: null }],
      reviewedFiles: { "src/app/api/qa_api.py": true },
      activeInsight: { type: "default", id: null },
    },
  });

  const validPath = join(root, "valid.json");
  await writeFile(validPath, JSON.stringify(validRecord), "utf8");
  assert.equal((await loadReviewSession(validPath))?.snapshot.comments?.[0]?.endLine, null);

  const invalidSnapshots: Array<{ name: string; mutate(snapshot: Record<string, any>): void }> = [
    {
      name: "non-array comments",
      mutate: (snapshot) => { snapshot.comments = {}; },
    },
    {
      name: "non-record reviewed files",
      mutate: (snapshot) => { snapshot.reviewedFiles = []; },
    },
    {
      name: "invalid active insight identity",
      mutate: (snapshot) => { snapshot.activeInsight = { type: "default", id: "finding-1" }; },
    },
    {
      name: "active comment insight for an unknown comment",
      mutate: (snapshot) => { snapshot.activeInsight = { type: "comment", id: "missing-comment" }; },
    },
    {
      name: "snapshot maps referencing unknown analysis IDs",
      mutate: (snapshot) => {
        snapshot.acceptedFindingComments = { "missing-finding": "Unknown" };
        snapshot.reviewedChapters = { "missing-chapter": true };
      },
    },
    {
      name: "confirmed intent without a receipt",
      mutate: (snapshot) => {
        snapshot.githubPublishIntent = {
          version: 1,
          status: "confirmed",
          correlationId: "review-intent-invalid-confirmed",
          source: validPublishSource,
          representedCommentIds: ["submitted"],
          submittedComments: [stagedComment()],
          createdAt: "2026-07-10T09:00:00Z",
          updatedAt: "2026-07-10T09:30:00Z",
        };
      },
    },
    {
      name: "intent whose represented IDs do not match submitted comments",
      mutate: (snapshot) => {
        snapshot.githubPublishIntent = {
          version: 1,
          status: "ambiguous",
          correlationId: "review-intent-invalid-comments",
          source: validPublishSource,
          representedCommentIds: ["submitted", "missing"],
          submittedComments: [stagedComment()],
          createdAt: "2026-07-10T09:00:00Z",
          updatedAt: "2026-07-10T09:30:00Z",
        };
      },
    },
    {
      name: "intent whose represented IDs are reordered from submitted comments",
      mutate: (snapshot) => {
        snapshot.githubPublishIntent = {
          version: 1,
          status: "ambiguous",
          correlationId: "review-intent-invalid-comment-order",
          source: validPublishSource,
          representedCommentIds: ["first", "second"],
          submittedComments: [stagedComment("second"), stagedComment("first")],
          createdAt: "2026-07-10T09:00:00Z",
          updatedAt: "2026-07-10T09:30:00Z",
        };
      },
    },
    {
      name: "intent with a correlation ID outside the publish contract",
      mutate: (snapshot) => {
        snapshot.githubPublishIntent = {
          version: 1,
          status: "pending",
          correlationId: "x",
          source: validPublishSource,
          representedCommentIds: ["submitted"],
          submittedComments: [stagedComment()],
          createdAt: "2026-07-10T09:00:00Z",
          updatedAt: "2026-07-10T09:30:00Z",
        };
      },
    },
  ];

  for (const [index, invalid] of invalidSnapshots.entries()) {
    await t.test(invalid.name, async () => {
      const snapshot = structuredClone(validRecord.snapshot) as unknown as Record<string, any>;
      invalid.mutate(snapshot);
      const record = buildReviewSessionRecord({
        sourceKey: fingerprint.sourceKey,
        fingerprint,
        analysis,
        snapshot,
      });
      const storagePath = join(root, `${index}.json`);
      await writeFile(storagePath, JSON.stringify(record), "utf8");
      await assert.rejects(loadReviewSession(storagePath), /invalid|incompatible/i);
    });
  }
});

test("save and load reject a hash-valid persisted correlation ID outside the publish contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-correlation-"));
  const storagePath = join(root, "session.json");
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const invalidIntent = {
    version: 1 as const,
    status: "pending" as const,
    correlationId: "x",
    source: { ...publishSource, sourceKey: fingerprint.sourceKey },
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
    createdAt: "2026-07-10T09:00:00Z",
    updatedAt: "2026-07-10T09:00:00Z",
  };
  const record = buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment()], githubPublishIntent: invalidIntent },
  });

  await assert.rejects(saveReviewSession(storagePath, record), /invalid|incompatible/i);
  await writeFile(storagePath, JSON.stringify(record), "utf8");
  await assert.rejects(loadReviewSession(storagePath), /invalid|incompatible/i);
});

test("strict loading preserves all-files progress outside the focused diff fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-all-files-"));
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const storagePath = join(root, "session.json");
  const unchangedFileId = "docs/unchanged.md";
  const record = buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: {
      activeFileId: unchangedFileId,
      reviewedFiles: { [unchangedFileId]: true },
      comments: [{
        id: "all-files-comment",
        fileId: unchangedFileId,
        scope: "all-files",
        side: "file",
        startLine: null,
        endLine: null,
        body: "This file is outside the focused diff fingerprint.",
      }],
    },
  });
  await writeFile(storagePath, JSON.stringify(record), "utf8");

  const restored = await loadReviewSession(storagePath);
  assert.equal(restored?.snapshot.activeFileId, unchangedFileId);
  assert.equal(restored?.snapshot.comments?.[0]?.fileId, unchangedFileId);
});

test("requires the pending intent save before invoking any remote publish operation", async () => {
  const persisted: ReviewSessionSnapshot[] = [];
  const harness = createPublishHarness({
    persist: async (snapshot) => {
      persisted.push(snapshot);
      return false;
    },
  });
  let remoteCalls = 0;

  await assert.rejects(harness.controller.runPublish({
    correlationId: "review-intent-1234567890",
    snapshot: { comments: [stagedComment()] },
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async () => {
    remoteCalls += 1;
    return { warnings: [] };
  }), /durably save.*pending publish intent/i);

  assert.equal(remoteCalls, 0);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.githubPublishIntent?.status, "pending");
  assert.deepEqual(persisted[0]?.githubPublishIntent?.source, publishSource);
});

test("rejects reordered publish comments before persistence or remote work", async () => {
  const persisted: ReviewSessionSnapshot[] = [];
  const harness = createPublishHarness({
    persist: async (snapshot) => {
      persisted.push(snapshot);
      return true;
    },
  });
  const first = stagedComment("first");
  const second = stagedComment("second");
  let remoteCalls = 0;

  await assert.rejects(harness.controller.runPublish({
    correlationId: "review-intent-comment-order",
    snapshot: { comments: [first, second] },
    representedCommentIds: [first.id, second.id],
    submittedComments: [second, first],
  }, async () => {
    remoteCalls += 1;
    return { warnings: [] };
  }), /order|exactly.*represented|payload/i);

  assert.equal(persisted.length, 0);
  assert.equal(remoteCalls, 0);
});

test("publish controller owns its intent across inputs, persistence, snapshots, and getters", async () => {
  let latest: ReviewSessionSnapshot = { comments: [stagedComment()] };
  const initialIntent: GitHubReviewPublishIntent = {
    version: 1,
    status: "confirmed",
    correlationId: "review-intent-owned-state",
    source: { ...publishSource },
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
    createdAt: "2026-07-10T09:00:00Z",
    updatedAt: "2026-07-10T09:30:00Z",
    receipt: { reviewId: 42, warnings: ["original warning"] },
  };
  const createController = (sessionStore as Record<string, unknown>).createGitHubPublishSessionController;
  assert.equal(typeof createController, "function");
  const controller = (createController as (options: Record<string, unknown>) => PublishSessionController)({
    source: publishSource,
    initialIntent,
    getSnapshot: () => latest,
    getRecordState: () => null,
    persistSnapshot: async (snapshot: ReviewSessionSnapshot) => {
      latest = snapshot;
      return true;
    },
  });

  initialIntent.source.owner = "mutated-input";
  initialIntent.representedCommentIds[0] = "mutated-input";
  initialIntent.submittedComments[0]!.body = "mutated input body";
  initialIntent.receipt!.warnings[0] = "mutated input warning";
  const exposed = controller.intent;
  assert.equal(exposed?.source.owner, "headout");
  assert.deepEqual(exposed?.representedCommentIds, ["submitted"]);
  assert.equal(exposed?.submittedComments[0]?.body, "Submitted body.");
  assert.deepEqual(exposed?.receipt?.warnings, ["original warning"]);

  assert.ok(exposed);
  exposed.source.owner = "mutated-getter";
  exposed.representedCommentIds[0] = "mutated-getter";
  exposed.submittedComments[0]!.body = "mutated getter body";
  exposed.receipt!.warnings[0] = "mutated getter warning";
  const merged = controller.mergeSnapshot({ comments: [] });
  assert.ok(merged.githubPublishIntent);
  merged.githubPublishIntent.source.owner = "mutated-snapshot";
  merged.githubPublishIntent.submittedComments[0]!.body = "mutated snapshot body";

  const owned = controller.intent;
  assert.equal(owned?.source.owner, "headout");
  assert.deepEqual(owned?.representedCommentIds, ["submitted"]);
  assert.equal(owned?.submittedComments[0]?.body, "Submitted body.");
  assert.deepEqual(owned?.receipt?.warnings, ["original warning"]);
});

test("persistence callbacks cannot mutate the controller's active intent", async () => {
  let latest: ReviewSessionSnapshot = { comments: [stagedComment()] };
  const createController = (sessionStore as Record<string, unknown>).createGitHubPublishSessionController;
  assert.equal(typeof createController, "function");
  const controller = (createController as (options: Record<string, unknown>) => PublishSessionController)({
    source: publishSource,
    initialIntent: null,
    getSnapshot: () => latest,
    getRecordState: () => null,
    persistSnapshot: async (snapshot: ReviewSessionSnapshot) => {
      latest = snapshot;
      const persistedIntent = snapshot.githubPublishIntent;
      if (persistedIntent != null) {
        persistedIntent.source.owner = "mutated-persistence";
        persistedIntent.representedCommentIds[0] = "mutated-persistence";
        persistedIntent.submittedComments[0]!.body = "mutated persistence body";
      }
      return true;
    },
  });

  await assert.rejects(controller.runPublish({
    correlationId: "review-intent-persistence-boundary",
    snapshot: latest,
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async () => {
    throw new Error("stop before POST");
  }), /stop before POST/);

  assert.equal(controller.intent?.source.owner, "headout");
  assert.deepEqual(controller.intent?.representedCommentIds, ["submitted"]);
  assert.equal(controller.intent?.submittedComments[0]?.body, "Submitted body.");
});

test("publishes only after pending and ambiguous saves and confirms against the latest renderer snapshot", async () => {
  const submitted = stagedComment();
  const unrelatedBefore = stagedComment("unrelated-before");
  const unrelatedDuring = stagedComment("unrelated-during");
  const events: string[] = [];
  let latest: ReviewSessionSnapshot = {
    overallComment: "stale overall comment",
    comments: [submitted, unrelatedBefore],
    reviewedFiles: { old: true },
  };
  let recordRevision = 0;
  let recordState: { revision: number; recordHash: string } | null = null;
  let controller!: PublishSessionController;
  const createController = (sessionStore as Record<string, unknown>).createGitHubPublishSessionController;
  assert.equal(typeof createController, "function");
  controller = (createController as (options: Record<string, unknown>) => PublishSessionController)({
    source: publishSource,
    initialIntent: null,
    getSnapshot: () => latest,
    getRecordState: () => recordState,
    persistSnapshot: async (snapshot: ReviewSessionSnapshot) => {
      events.push(`save:${snapshot.githubPublishIntent?.status ?? "none"}`);
      latest = snapshot;
      recordRevision += 1;
      recordState = { revision: recordRevision, recordHash: recordRevision.toString(16).padStart(64, "0") };
      return true;
    },
    now: () => "2026-07-10T09:00:00Z",
  });

  await controller.runPublish({
    correlationId: "review-intent-1234567890",
    snapshot: latest,
    representedCommentIds: [submitted.id],
    submittedComments: [submitted],
  }, async (beforePost) => {
    assert.deepEqual(events, ["save:pending"]);
    await beforePost();
    events.push("remote:POST");
    latest = controller.mergeSnapshot({
      overallComment: "latest renderer comment",
      comments: [{ ...submitted, body: "renderer changed the submitted body" }, unrelatedDuring],
      reviewedFiles: { newest: true },
    });
    return {
      reviewId: 4321,
      reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
      submittedAt: "2026-07-10T09:30:00Z",
      warnings: [],
    };
  });

  assert.deepEqual(events, ["save:pending", "save:ambiguous", "remote:POST", "save:confirmed"]);
  assert.equal(latest.overallComment, "latest renderer comment");
  assert.deepEqual(latest.reviewedFiles, { newest: true });
  assert.deepEqual(latest.comments?.map((comment) => comment.id), ["unrelated-during", "submitted"]);
  assert.equal(latest.comments?.[0], unrelatedDuring);
  assert.deepEqual(latest.comments?.[1], {
    ...submitted,
    status: "published",
    published: true,
    publishedAt: "2026-07-10T09:30:00Z",
    githubReviewId: 4321,
    githubReviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
  });
  assert.equal(latest.githubPublishIntent?.status, "confirmed");
  assert.equal(latest.githubPublishIntent?.receipt?.reviewId, 4321);
});

test("a failed confirmed-intent save leaves publishing blocked after remote success", async () => {
  let remoteCalls = 0;
  const statuses: string[] = [];
  const harness = createPublishHarness({
    persist: async (snapshot) => {
      const status = snapshot.githubPublishIntent?.status ?? "none";
      statuses.push(status);
      return status !== "confirmed";
    },
  });

  await assert.rejects(harness.controller.runPublish({
    correlationId: "review-intent-confirm-save-failure",
    snapshot: harness.latest(),
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async (beforePost) => {
    await beforePost();
    remoteCalls += 1;
    return {
      reviewId: 4321,
      reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
      submittedAt: "2026-07-10T09:30:00Z",
      warnings: [],
    };
  }), /confirmed receipt could not be durably saved|do not retry/i);

  assert.equal(harness.controller.intent?.status, "ambiguous");
  assert.equal(harness.latest().githubPublishIntent?.status, "ambiguous");
  await assert.rejects(harness.controller.runPublish({
    correlationId: "review-intent-must-not-retry",
    snapshot: harness.latest(),
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async () => {
    remoteCalls += 1;
    return { warnings: [] };
  }), /outstanding|ambiguous|blocked/i);

  assert.equal(remoteCalls, 1);
  assert.deepEqual(statuses.slice(0, 3), ["pending", "ambiguous", "confirmed"]);
});

test("a deferred renderer autosave reconstructs published comments from the confirmed intent", async () => {
  const submitted = stagedComment();
  const deferredAutosave: ReviewSessionSnapshot = {
    overallComment: "renderer state captured while POST was in flight",
    comments: [
      { ...submitted, body: "stale renderer body", status: "staged", published: false },
      stagedComment("newer-staged"),
    ],
    reviewedFiles: { newest: true },
  };
  const harness = createPublishHarness();

  await harness.controller.runPublish({
    correlationId: "review-intent-deferred-autosave",
    snapshot: harness.latest(),
    representedCommentIds: [submitted.id],
    submittedComments: [submitted],
  }, async (beforePost) => {
    await beforePost();
    return {
      reviewId: 4321,
      reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
      submittedAt: "2026-07-10T09:30:00Z",
      warnings: [],
    };
  });

  const merged = harness.controller.mergeSnapshot(deferredAutosave);
  assert.equal(merged.overallComment, deferredAutosave.overallComment);
  assert.deepEqual(merged.reviewedFiles, { newest: true });
  assert.deepEqual(merged.comments?.map((comment) => comment.id), ["newer-staged", "submitted"]);
  assert.deepEqual(merged.comments?.[1], {
    ...submitted,
    status: "published",
    published: true,
    publishedAt: "2026-07-10T09:30:00Z",
    githubReviewId: 4321,
    githubReviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
  });
});

test("restart reconciliation confirms an ambiguous intent without a second remote publish", async () => {
  const first = createPublishHarness();
  await assert.rejects(first.controller.runPublish({
    correlationId: "review-intent-1234567890",
    snapshot: first.latest(),
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async (beforePost) => {
    await beforePost();
    throw new Error("POST timed out after the request may have been accepted");
  }), /timed out/);
  assert.equal(first.latest().githubPublishIntent?.status, "ambiguous");

  const restoredSnapshot = structuredClone(first.latest());
  const restarted = createPublishHarness({ snapshot: restoredSnapshot });
  let reconciliationGets = 0;
  const result = await restarted.controller.reconcileOutstanding(async () => {
    reconciliationGets += 1;
    return {
      reviewId: 4321,
      reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
      submittedAt: "2026-07-10T09:30:00Z",
      warnings: [],
    };
  });

  assert.equal(reconciliationGets, 1);
  assert.equal(result.status, "confirmed");
  assert.equal(restarted.latest().githubPublishIntent?.status, "confirmed");
  assert.equal(restarted.latest().comments?.find((comment) => comment.id === "submitted")?.status, "published");
});

test("an unresolved ambiguous restart remains blocked and cannot start another POST", async () => {
  const first = createPublishHarness();
  await assert.rejects(first.controller.runPublish({
    correlationId: "review-intent-1234567890",
    snapshot: first.latest(),
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async (beforePost) => {
    await beforePost();
    throw new Error("ambiguous POST result");
  }), /ambiguous POST result/);

  const restarted = createPublishHarness({ snapshot: structuredClone(first.latest()) });
  const reconciliation = await restarted.controller.reconcileOutstanding(async () => null);
  assert.equal(reconciliation.status, "blocked");
  assert.match(reconciliation.warning ?? "", /ambiguous.*blocked|blocked.*ambiguous/i);
  assert.match(reconciliation.warning ?? "", /--abandon-ambiguous-publish/);
  assert.match(reconciliation.warning ?? "", /duplicate/i);
  let secondPosts = 0;
  await assert.rejects(restarted.controller.runPublish({
    correlationId: "review-intent-second-1234",
    snapshot: restarted.latest(),
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async () => {
    secondPosts += 1;
    return { warnings: [] };
  }), /outstanding|ambiguous|blocked/i);
  assert.equal(secondPosts, 0);
});

test("explicitly abandoning an ambiguous intent preserves review progress and warns about duplicate risk", async () => {
  const first = createPublishHarness({
    snapshot: {
      overallComment: "Keep my progress",
      comments: [stagedComment(), stagedComment("unrelated")],
      reviewedFiles: { "src/app/api/qa_api.py": true },
    },
  });
  await assert.rejects(first.controller.runPublish({
    correlationId: "review-intent-abandon-ambiguous",
    snapshot: first.latest(),
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async (beforePost) => {
    await beforePost();
    throw new Error("ambiguous POST result");
  }));

  const restarted = createPublishHarness({ snapshot: structuredClone(first.latest()) });
  const result = await restarted.controller.abandonOutstanding();

  assert.equal(result.status, "abandoned");
  assert.match(result.warning ?? "", /duplicate/i);
  assert.equal(restarted.latest().githubPublishIntent, undefined);
  assert.equal(restarted.latest().overallComment, "Keep my progress");
  assert.deepEqual(restarted.latest().reviewedFiles, { "src/app/api/qa_api.py": true });
  assert.deepEqual(restarted.latest().comments?.map((comment) => comment.id), ["submitted", "unrelated"]);
});

test("an outstanding intent with a different source lock opens blocked without reconciliation", async () => {
  const first = createPublishHarness();
  await assert.rejects(first.controller.runPublish({
    correlationId: "review-intent-1234567890",
    snapshot: first.latest(),
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async (beforePost) => {
    await beforePost();
    throw new Error("ambiguous POST result");
  }));

  const restarted = createPublishHarness({
    snapshot: structuredClone(first.latest()),
    source: { ...publishSource, repo: "different-repo" },
  });
  let remoteReads = 0;
  const result = await restarted.controller.reconcileOutstanding(async () => {
    remoteReads += 1;
    return null;
  });
  assert.equal(result.status, "blocked");
  assert.match(result.warning ?? "", /source lock/i);
  assert.equal(remoteReads, 0);
});

test("an outstanding intent for a different reviewed head opens blocked without reconciliation", async () => {
  const first = createPublishHarness();
  await assert.rejects(first.controller.runPublish({
    correlationId: "review-intent-head-lock",
    snapshot: first.latest(),
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async (beforePost) => {
    await beforePost();
    throw new Error("ambiguous POST result");
  }));

  const restarted = createPublishHarness({
    snapshot: structuredClone(first.latest()),
    source: { ...publishSource, reviewedHeadSha: "different-reviewed-head" },
  });
  let remoteReads = 0;
  const result = await restarted.controller.reconcileOutstanding(async () => {
    remoteReads += 1;
    return null;
  });
  assert.equal(result.status, "blocked");
  assert.match(result.warning ?? "", /source lock/i);
  assert.equal(remoteReads, 0);
});

test("authoritative published comments survive renderer downgrade and omission while new staged comments are saved", () => {
  const mergePublished = (sessionStore as Record<string, unknown>).mergeAuthoritativePublishedComments;
  assert.equal(typeof mergePublished, "function");
  if (typeof mergePublished !== "function") return;

  const published = {
    id: "published-1",
    fileId: "src/app/api/qa_api.py",
    scope: "git-diff" as const,
    side: "modified" as const,
    startLine: 1,
    endLine: 1,
    body: "Published host body.",
    status: "published" as const,
    published: true,
    publishedAt: "2026-07-10T09:00:00Z",
    githubReviewId: 1234,
    githubReviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-1234",
  };
  const staged = {
    id: "staged-1",
    fileId: "src/app/api/qa_api.py",
    scope: "git-diff" as const,
    side: "modified" as const,
    startLine: 2,
    endLine: 2,
    body: "Fresh staged note.",
  };

  const downgraded = (mergePublished as (snapshot: unknown, published: unknown) => unknown)(
    {
      comments: [
        { ...published, body: "Renderer changed this.", status: "staged", published: false, publishedAt: undefined },
        staged,
      ],
    },
    [published],
  ) as { comments: Array<Record<string, unknown>> };
  assert.deepEqual(downgraded.comments, [staged, published]);

  const reopened = (mergePublished as (snapshot: unknown, published: unknown) => unknown)(
    { comments: [staged] },
    downgraded.comments.filter((comment) => comment.id === "published-1"),
  ) as { comments: Array<Record<string, unknown>> };
  assert.deepEqual(reopened.comments, [staged, published]);
});

test("marks every represented comment published with receipt metadata without changing unrelated staged comments", () => {
  const markPublished = (sessionStore as Record<string, unknown>).markGitHubReviewCommentsPublished;
  assert.equal(typeof markPublished, "function");
  if (typeof markPublished !== "function") return;

  const snapshot = {
    comments: [
      {
        id: "inline",
        fileId: "file-1",
        scope: "git-diff",
        side: "modified",
        startLine: 4,
        endLine: 4,
        body: "Inline note.",
      },
      {
        id: "file",
        fileId: "file-1",
        scope: "all-files",
        side: "file",
        startLine: null,
        endLine: null,
        body: "File note.",
      },
      {
        id: "staged",
        fileId: "file-1",
        scope: "git-diff",
        side: "modified",
        startLine: 5,
        endLine: 5,
        body: "Still staged.",
      },
    ],
  };
  const result = (markPublished as (snapshot: unknown, ids: unknown, receipt: unknown, publishedAt: string) => unknown)(
    snapshot,
    ["inline", "file"],
    { reviewId: 1234, reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-1234" },
    "2026-07-10T09:00:00Z",
  ) as { comments: Array<Record<string, unknown>> };

  assert.deepEqual(result.comments.map((comment) => ({
    id: comment.id,
    status: comment.status,
    published: comment.published,
    publishedAt: comment.publishedAt,
    githubReviewId: comment.githubReviewId,
    githubReviewUrl: comment.githubReviewUrl,
  })), [
    {
      id: "inline",
      status: "published",
      published: true,
      publishedAt: "2026-07-10T09:00:00Z",
      githubReviewId: 1234,
      githubReviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-1234",
    },
    {
      id: "file",
      status: "published",
      published: true,
      publishedAt: "2026-07-10T09:00:00Z",
      githubReviewId: 1234,
      githubReviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-1234",
    },
    {
      id: "staged",
      status: undefined,
      published: undefined,
      publishedAt: undefined,
      githubReviewId: undefined,
      githubReviewUrl: undefined,
    },
  ]);
});

test("published comments survive save, load, and reopen when the renderer omits them", async () => {
  const publishedCommentsFromSnapshot = (sessionStore as Record<string, unknown>).publishedCommentsFromSnapshot;
  assert.equal(typeof publishedCommentsFromSnapshot, "function");
  if (typeof publishedCommentsFromSnapshot !== "function") return;

  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const publishedSnapshot = (sessionStore as Record<string, unknown>).markGitHubReviewCommentsPublished as (
    snapshot: unknown,
    ids: unknown,
    receipt: unknown,
    publishedAt: string,
  ) => { comments: Array<Record<string, unknown>> };
  const snapshot = publishedSnapshot({
    comments: [{
      id: "published-1",
      fileId: "src/app/api/qa_api.py",
      scope: "git-diff",
      side: "modified",
      startLine: 1,
      endLine: 1,
      body: "Published note.",
    }],
  }, ["published-1"], { reviewId: 1234, reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-1234" }, "2026-07-10T09:00:00Z");
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-"));
  const storagePath = join(root, "session.json");
  await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: snapshot as never,
  }));

  const restored = await loadReviewSession(storagePath);
  const reopened = (sessionStore as Record<string, unknown>).mergeAuthoritativePublishedComments as (
    snapshot: unknown,
    published: unknown,
  ) => { comments: Array<Record<string, unknown>> };
  const merged = reopened({
    comments: [{
      id: "new-staged",
      fileId: "src/app/api/qa_api.py",
      scope: "git-diff",
      side: "modified",
      startLine: 2,
      endLine: 2,
      body: "New staged note.",
    }],
  }, (publishedCommentsFromSnapshot as (value: unknown) => unknown)(restored?.snapshot));

  assert.deepEqual(merged.comments.map((comment) => comment.id), ["new-staged", "published-1"]);
  assert.equal(merged.comments[1]?.status, "published");
  assert.equal(merged.comments[1]?.githubReviewId, 1234);
});

test("durable session writes use exclusive random temps and fsync the file before rename and parent after", async () => {
  const writeDurably = (sessionStore as Record<string, unknown>).writeReviewSessionFileDurably;
  assert.equal(typeof writeDurably, "function");
  if (typeof writeDurably !== "function") return;

  const events: string[] = [];
  const tempPaths: string[] = [];
  const dependencies = {
    mkdir: async (path: string) => { events.push(`mkdir:${path}`); },
    open: async (path: string, flags: string) => {
      if (flags === "wx") tempPaths.push(path);
      events.push(`open:${flags}:${path}`);
      const label = flags === "wx" ? "temp" : "parent";
      return {
        writeFile: async (contents: string) => { events.push(`write:${contents}`); },
        sync: async () => { events.push(`sync:${label}`); },
        close: async () => { events.push(`close:${label}`); },
      };
    },
    rename: async (from: string, to: string) => { events.push(`rename:${from}:${to}`); },
    rm: async (path: string) => { events.push(`rm:${path}`); },
  };
  const invoke = writeDurably as (
    path: string,
    contents: string,
    dependencies: Record<string, unknown>,
  ) => Promise<void>;

  await invoke("/virtual/reviews/session.json", "first", dependencies);
  await invoke("/virtual/reviews/session.json", "second", dependencies);

  assert.equal(tempPaths.length, 2);
  assert.notEqual(tempPaths[0], tempPaths[1]);
  assert.equal(tempPaths.every((path) => path.startsWith("/virtual/reviews/session.json.") && path.endsWith(".tmp")), true);
  for (const contents of ["first", "second"]) {
    const writeIndex = events.indexOf(`write:${contents}`);
    const fileSyncIndex = events.indexOf("sync:temp", writeIndex);
    const renameIndex = events.findIndex((event, index) => index > fileSyncIndex && event.startsWith("rename:"));
    const parentSyncIndex = events.indexOf("sync:parent", renameIndex);
    assert.ok(writeIndex >= 0);
    assert.ok(fileSyncIndex > writeIndex);
    assert.ok(renameIndex > fileSyncIndex);
    assert.ok(parentSyncIndex > renameIndex);
  }
  assert.equal(events.some((event) => event.startsWith("rm:")), false);
});

test("the dual session lock fails closed when either lockf or shlock is unavailable", async () => {
  const acquire = (sessionStore as Record<string, unknown>).acquireReviewSessionLock;
  assert.equal(typeof acquire, "function");
  if (typeof acquire !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-lock-"));
  const storagePath = join(root, "session.json");
  const invoke = acquire as (
    path: string,
    options: Record<string, unknown>,
  ) => Promise<() => Promise<void>>;

  for (const [name, options] of [
    ["lockf", { lockfPath: join(root, "missing-lockf"), shlockPath: "/usr/bin/shlock" }],
    ["shlock", { lockfPath: "/usr/bin/lockf", shlockPath: join(root, "missing-shlock") }],
  ] as const) {
    const outcome = await invoke(storagePath, {
      timeoutMs: 40,
      retryDelayMs: 5,
      ...options,
    }).then(
      (release) => ({ release }),
      (error: unknown) => ({ error }),
    );
    if ("release" in outcome) await outcome.release();
    assert.equal("error" in outcome, true, `${name} unexpectedly fell back to another lock protocol`);
    if ("error" in outcome) assert.match(String(outcome.error), new RegExp(`${name}.*unavailable|cannot be updated safely`, "i"));
  }
});

test("lockf has acquired the kernel lock and forwarded READY before shlock starts", async () => {
  const acquire = (sessionStore as Record<string, unknown>).acquireReviewSessionLock;
  assert.equal(typeof acquire, "function");
  if (typeof acquire !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-lock-order-"));
  const storagePath = join(root, "session.json");
  const lockfWrapperPath = join(root, "gated-lockf");
  const shlockWrapperPath = join(root, "observed-shlock");
  const lockfReadyHeldPath = join(root, "lockf-ready-held");
  const forwardReadyGatePath = join(root, "forward-ready");
  const lockfReadyForwardedPath = join(root, "lockf-ready-forwarded");
  const shlockStartedPath = join(root, "shlock-started");
  const orderingViolationPath = join(root, "ordering-violation");
  const executableHeader = `#!${process.execPath}\n`;
  await writeFile(lockfWrapperPath, executableHeader + `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn("/usr/bin/lockf", process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);
let stdout = "";
let readyHeld = false;
child.stdout.on("data", (chunk) => {
  stdout += String(chunk);
  if (readyHeld || !stdout.includes("lock-acquired:")) return;
  readyHeld = true;
  fs.writeFileSync(${JSON.stringify(lockfReadyHeldPath)}, stdout);
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(forwardReadyGatePath)})) return;
    clearInterval(timer);
    fs.writeFileSync(${JSON.stringify(lockfReadyForwardedPath)}, "forwarded");
    process.stdout.write(stdout);
  }, 5);
});
child.once("exit", (code) => process.exit(code ?? 70));
`, "utf8");
  await writeFile(shlockWrapperPath, executableHeader + `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
if (!fs.existsSync(${JSON.stringify(lockfReadyForwardedPath)})) {
  fs.writeFileSync(${JSON.stringify(orderingViolationPath)}, "shlock started before READY");
  process.exit(70);
}
fs.writeFileSync(${JSON.stringify(shlockStartedPath)}, "started");
const result = spawnSync("/usr/bin/shlock", process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 70);
`, "utf8");
  await Promise.all([chmod(lockfWrapperPath, 0o755), chmod(shlockWrapperPath, 0o755)]);

  const acquisition = (acquire as (
    path: string,
    options: Record<string, unknown>,
  ) => Promise<() => Promise<void>>)(storagePath, {
    timeoutMs: 1_000,
    retryDelayMs: 5,
    lockfPath: lockfWrapperPath,
    shlockPath: shlockWrapperPath,
  });

  await waitForPath(lockfReadyHeldPath);
  assert.equal(existsSync(shlockStartedPath), false);
  assert.equal(existsSync(lockfReadyForwardedPath), false);
  await writeFile(forwardReadyGatePath, "continue", "utf8");
  await waitForPath(shlockStartedPath);
  const release = await acquisition;

  assert.equal(existsSync(lockfReadyForwardedPath), true);
  assert.equal(existsSync(orderingViolationPath), false);
  await release();
});

test("each externally held lock layer independently excludes the dual-lock client", async (t) => {
  const acquire = (sessionStore as Record<string, unknown>).acquireReviewSessionLock;
  assert.equal(typeof acquire, "function");
  if (typeof acquire !== "function") return;
  const invoke = acquire as (
    path: string,
    options: Record<string, unknown>,
  ) => Promise<() => Promise<void>>;
  const executableHeader = `#!${process.execPath}\n`;

  await t.test("an external lockf-only holder blocks before shlock", async (layerTest) => {
    const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-external-lockf-"));
    const storagePath = join(root, "session.json");
    const lockPath = `${root}.lock`;
    const holderReadyPath = join(root, "holder-ready");
    const clientLockfPath = join(root, "observed-lockf");
    const clientLockfAttemptPath = join(root, "client-lockf-attempt");
    const clientShlockPath = join(root, "observed-shlock");
    const clientShlockAttemptPath = join(root, "client-shlock-attempt");
    const holderSource = `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(holderReadyPath)}, String(process.pid));
      process.stdin.once("end", () => process.exit(0));
      process.stdin.resume();
    `;
    const holder = spawn("/usr/bin/lockf", [
      "-k", "-s", "-w", "-t", "0", lockPath,
      process.execPath, "--input-type=commonjs", "--eval", holderSource,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    layerTest.after(() => {
      if (holder.exitCode == null && holder.signalCode == null) holder.kill("SIGKILL");
    });
    await waitForPath(holderReadyPath);
    await writeFile(clientLockfPath, executableHeader + `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
fs.writeFileSync(${JSON.stringify(clientLockfAttemptPath)}, "attempted");
const result = spawnSync("/usr/bin/lockf", process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 70);
`, "utf8");
    await writeFile(clientShlockPath, executableHeader + `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(clientShlockAttemptPath)}, "attempted");
process.exit(70);
`, "utf8");
    await Promise.all([chmod(clientLockfPath, 0o755), chmod(clientShlockPath, 0o755)]);

    const blocked = invoke(storagePath, {
      timeoutMs: 80,
      retryDelayMs: 5,
      lockfPath: clientLockfPath,
      shlockPath: clientShlockPath,
    }).then(
      async (release) => {
        await release();
        return { status: "fulfilled" as const };
      },
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await waitForPath(clientLockfAttemptPath);
    const outcome = await blocked;

    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.match(String(outcome.error), /timed out|another process|lock/i);
    assert.equal(existsSync(clientShlockAttemptPath), false);
    const exited = once(holder, "exit");
    holder.stdin.end();
    const [exitCode] = await exited;
    assert.equal(exitCode, 0);
  });

  await t.test("an external shlock-only PID guard blocks after lockf", async (layerTest) => {
    const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-external-shlock-"));
    const storagePath = join(root, "session.json");
    const pidGuardPath = `${root}.lock.pid`;
    const holderReadyPath = join(root, "holder-ready");
    const clientLockfPath = join(root, "observed-lockf");
    const clientLockfReadyPath = join(root, "client-lockf-ready");
    const holderSource = `
      const fs = require("node:fs");
      const { spawnSync } = require("node:child_process");
      const result = spawnSync("/usr/bin/shlock", ["-p", String(process.pid), "-f", ${JSON.stringify(pidGuardPath)}]);
      if (result.status !== 0) process.exit(result.status ?? 70);
      fs.writeFileSync(${JSON.stringify(holderReadyPath)}, String(process.pid));
      process.stdin.once("end", () => process.exit(0));
      process.stdin.resume();
    `;
    const holder = spawn(process.execPath, ["--input-type=commonjs", "--eval", holderSource], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    layerTest.after(() => {
      if (holder.exitCode == null && holder.signalCode == null) holder.kill("SIGKILL");
    });
    await waitForPath(holderReadyPath);
    const heldStat = await stat(pidGuardPath);
    const heldContents = await readFile(pidGuardPath, "utf8");
    await writeFile(clientLockfPath, executableHeader + `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn("/usr/bin/lockf", process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);
let stdout = "";
child.stdout.on("data", (chunk) => {
  stdout += String(chunk);
  if (stdout.includes("lock-acquired:")) fs.writeFileSync(${JSON.stringify(clientLockfReadyPath)}, stdout);
  process.stdout.write(chunk);
});
child.once("exit", (code) => process.exit(code ?? 70));
`, "utf8");
    await chmod(clientLockfPath, 0o755);

    const blocked = invoke(storagePath, {
      timeoutMs: 120,
      retryDelayMs: 5,
      lockfPath: clientLockfPath,
      shlockPath: "/usr/bin/shlock",
    }).then(
      async (release) => {
        await release();
        return { status: "fulfilled" as const };
      },
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await waitForPath(clientLockfReadyPath);
    const outcome = await blocked;

    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.match(String(outcome.error), /timed out|another process|PID guard/i);
    const guardAfter = await stat(pidGuardPath);
    assert.equal(guardAfter.dev, heldStat.dev);
    assert.equal(guardAfter.ino, heldStat.ino);
    assert.equal(await readFile(pidGuardPath, "utf8"), heldContents);
    const exited = once(holder, "exit");
    holder.stdin.end();
    const [exitCode] = await exited;
    assert.equal(exitCode, 0);
  });
});

test("lockf loss settles and cleans an in-flight shlock acquisition before rejecting", async () => {
  const acquire = (sessionStore as Record<string, unknown>).acquireReviewSessionLock;
  assert.equal(typeof acquire, "function");
  if (typeof acquire !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-shlock-race-"));
  const storagePath = join(root, "session.json");
  const pidGuardPath = `${root}.lock.pid`;
  const fakeLockfPath = join(root, "fake-lockf");
  const delayedShlockPath = join(root, "delayed-shlock");
  const shlockStartedPath = join(root, "shlock-started");
  const shlockGatePath = join(root, "shlock-gate");
  const shlockFinishedPath = join(root, "shlock-finished");
  const lockfLossGatePath = join(root, "lockf-loss-gate");
  const lockfLossObservedPath = join(root, "lockf-loss-observed");
  const lockfPidPath = join(root, "lockf-pid");
  const executableHeader = `#!${process.execPath}\n`;
  await writeFile(fakeLockfPath, executableHeader + `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(lockfPidPath)}, String(process.pid));
process.stdout.write("lock-acquired:" + process.pid + "\\n");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(lockfLossGatePath)})) return;
  clearInterval(timer);
  fs.writeFileSync(${JSON.stringify(lockfLossObservedPath)}, "lost");
  process.exit(70);
}, 5);
`, "utf8");
  await writeFile(delayedShlockPath, executableHeader + `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
fs.writeFileSync(${JSON.stringify(shlockStartedPath)}, "started");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(shlockGatePath)})) return;
  clearInterval(timer);
  const result = spawnSync("/usr/bin/shlock", process.argv.slice(2), { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(shlockFinishedPath)}, String(result.status));
  process.exit(result.status ?? 70);
}, 5);
`, "utf8");
  await Promise.all([chmod(fakeLockfPath, 0o755), chmod(delayedShlockPath, 0o755)]);

  let acquisitionSettled = false;
  const acquisition = (acquire as (
    path: string,
    options: Record<string, unknown>,
  ) => Promise<() => Promise<void>>)(storagePath, {
    timeoutMs: 1_000,
    retryDelayMs: 5,
    lockfPath: fakeLockfPath,
    shlockPath: delayedShlockPath,
  }).then(
    async (release) => {
      await release();
      return { status: "fulfilled" as const };
    },
    (error: unknown) => ({ status: "rejected" as const, error }),
  ).finally(() => { acquisitionSettled = true; });

  await waitForPath(shlockStartedPath);
  await writeFile(lockfLossGatePath, "lose", "utf8");
  await waitForPath(lockfLossObservedPath);
  await waitForProcessExit(Number.parseInt(await readFile(lockfPidPath, "utf8"), 10));
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(acquisitionSettled, false, "acquisition settled while shlock was still gated");
  assert.equal(existsSync(shlockFinishedPath), false);
  await writeFile(shlockGatePath, "continue", "utf8");

  const outcome = await acquisition;
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.match(String(outcome.error), /lockf.*holder|lock.*lost/i);
  assert.equal(existsSync(shlockFinishedPath), true);
  assert.equal(existsSync(pidGuardPath), false, "the abandoned shlock acquisition leaked its PID guard");

  const release = await (acquire as (
    path: string,
    options: Record<string, unknown>,
  ) => Promise<() => Promise<void>>)(storagePath, {
    timeoutMs: 1_000,
    retryDelayMs: 5,
  });
  await release();
});

test("stale release preserves a replacement PID guard with the same owner text", async () => {
  const acquire = (sessionStore as Record<string, unknown>).acquireReviewSessionLock;
  assert.equal(typeof acquire, "function");
  if (typeof acquire !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-pid-successor-"));
  const storagePath = join(root, "session.json");
  const pidGuardPath = `${root}.lock.pid`;
  const successorPath = join(root, "successor.pid");
  const release = await (acquire as (
    path: string,
    options: Record<string, unknown>,
  ) => Promise<() => Promise<void>>)(storagePath, {
    timeoutMs: 1_000,
    retryDelayMs: 5,
    lockfPath: "/usr/bin/lockf",
    shlockPath: "/usr/bin/shlock",
  });
  const acquiredStat = await stat(pidGuardPath);
  const acquiredContents = await readFile(pidGuardPath, "utf8");

  await writeFile(successorPath, acquiredContents, "utf8");
  const successorStat = await stat(successorPath);
  assert.notEqual(successorStat.ino, acquiredStat.ino);
  await rename(successorPath, pidGuardPath);
  await release();

  const survivingStat = await stat(pidGuardPath);
  assert.equal(survivingStat.dev, successorStat.dev);
  assert.equal(survivingStat.ino, successorStat.ino);
  assert.equal(await readFile(pidGuardPath, "utf8"), acquiredContents);
});

test("stale release preserves a PID guard whose owner changed on the acquired inode", async () => {
  const acquire = (sessionStore as Record<string, unknown>).acquireReviewSessionLock;
  assert.equal(typeof acquire, "function");
  if (typeof acquire !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-pid-owner-"));
  const storagePath = join(root, "session.json");
  const pidGuardPath = `${root}.lock.pid`;
  const release = await (acquire as (
    path: string,
    options: Record<string, unknown>,
  ) => Promise<() => Promise<void>>)(storagePath, {
    timeoutMs: 1_000,
    retryDelayMs: 5,
    lockfPath: "/usr/bin/lockf",
    shlockPath: "/usr/bin/shlock",
  });
  const acquiredStat = await stat(pidGuardPath);
  const successorOwner = "2147483647\n";

  await writeFile(pidGuardPath, successorOwner, "utf8");
  const changedOwnerStat = await stat(pidGuardPath);
  assert.equal(changedOwnerStat.dev, acquiredStat.dev);
  assert.equal(changedOwnerStat.ino, acquiredStat.ino);
  await release();

  assert.equal(await readFile(pidGuardPath, "utf8"), successorOwner);
  await rm(pidGuardPath);
});

test("the dual session lock ignores stale kernel-lock contents, excludes contenders, and releases cleanly", async () => {
  const acquire = (sessionStore as Record<string, unknown>).acquireReviewSessionLock;
  assert.equal(typeof acquire, "function");
  if (typeof acquire !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-lockf-"));
  const storagePath = join(root, "session.json");
  const lockPath = `${root}.lock`;
  const lockOptions = {
    timeoutMs: 1_000,
    retryDelayMs: 5,
    lockfPath: "/usr/bin/lockf",
  };
  const invoke = acquire as (
    path: string,
    options: typeof lockOptions,
  ) => Promise<() => Promise<void>>;

  // A pathname is not a lock. Even a live PID left in it must not block lockf.
  await writeFile(lockPath, `${process.pid}\n`, "utf8");
  const releaseOwner = await invoke(storagePath, lockOptions);
  await assert.rejects(
    invoke(storagePath, { ...lockOptions, timeoutMs: 40 }),
    /timed out|another process|lock/i,
  );
  await releaseOwner();

  const releaseAfterOwner = await invoke(storagePath, lockOptions);
  await releaseAfterOwner();
});

test("an empty PATH cannot terminate the lock holder or admit a second transaction", async (t) => {
  const withTransaction = (sessionStore as Record<string, unknown>).withReviewSessionTransaction;
  assert.equal(typeof withTransaction, "function");
  if (typeof withTransaction !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-empty-path-"));
  const storagePath = join(root, "session.json");
  const moduleUrl = new URL("../src/session-store.ts", import.meta.url).href;
  const holderScript = `
    import { withReviewSessionTransaction } from ${JSON.stringify(moduleUrl)};
    await withReviewSessionTransaction(${JSON.stringify(storagePath)}, async () => {
      process.stdout.write("task-ready\\n");
      await new Promise((resolve) => process.stdin.once("data", resolve));
    });
  `;
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", holderScript], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (holder.exitCode == null && holder.signalCode == null) holder.kill("SIGKILL");
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => rejectReady(new Error(`empty-PATH holder did not become ready: ${stderr}`)), 5_000);
    holder.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (!stdout.includes("task-ready\n")) return;
      clearTimeout(timeout);
      resolveReady();
    });
    holder.stderr.on("data", (chunk) => { stderr += String(chunk); });
    holder.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`empty-PATH holder exited before ready: ${code ?? signal}; ${stderr}`));
    });
  });
  await delay(50);

  let secondEntered = false;
  const second = (withTransaction as (
    path: string,
    task: () => Promise<void>,
  ) => Promise<void>)(storagePath, async () => { secondEntered = true; });
  await delay(75);
  const overlapped = secondEntered;
  holder.stdin.end("finish\n");
  const [exitCode] = await once(holder, "exit");
  await second;

  assert.equal(overlapped, false);
  assert.equal(exitCode, 0);
});

test("killing the ready lockf holder cannot admit a second active transaction", async () => {
  const withTransaction = (sessionStore as Record<string, unknown>).withReviewSessionTransaction;
  assert.equal(typeof withTransaction, "function");
  if (typeof withTransaction !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-killed-holder-"));
  const storagePath = join(root, "session.json");
  const holderReady = deferred<number>();
  const taskStarted = deferred<void>();
  const finishTask = deferred<void>();
  const invoke = withTransaction as <T>(
    path: string,
    task: () => Promise<T>,
    options?: Record<string, unknown>,
  ) => Promise<T>;
  const first = invoke(storagePath, async () => {
    taskStarted.resolve();
    await finishTask.promise;
  }, {
    lockfPath: "/usr/bin/lockf",
    shlockPath: "/usr/bin/shlock",
    onLockfHolderReady: (pid: number) => holderReady.resolve(pid),
  });
  let readinessTimer: ReturnType<typeof setTimeout> | null = null;
  const holderPid = await Promise.race([
    holderReady.promise,
    new Promise<null>((resolveTimeout) => {
      readinessTimer = setTimeout(() => resolveTimeout(null), 3_000);
    }),
  ]);
  if (readinessTimer != null) clearTimeout(readinessTimer);
  if (holderPid == null) {
    finishTask.resolve();
    await first;
    assert.fail("the production lock did not expose its ready holder for failure testing");
  }
  await taskStarted.promise;
  process.kill(holderPid, "SIGKILL");

  let secondEntered = false;
  const second = invoke(storagePath, async () => { secondEntered = true; });
  await delay(75);
  const overlapped = secondEntered;
  finishTask.resolve();
  const firstOutcome = await first.then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  await second;

  assert.equal(overlapped, false);
  assert.equal(firstOutcome.status, "rejected");
  if (firstOutcome.status === "rejected") assert.match(String(firstOutcome.error), /lockf.*holder.*exit|lock.*lost/i);
});

test("the dual session lock is released when its parent dies", async (t) => {
  const acquire = (sessionStore as Record<string, unknown>).acquireReviewSessionLock;
  assert.equal(typeof acquire, "function");
  if (typeof acquire !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-lockf-parent-"));
  const storagePath = join(root, "session.json");
  const moduleUrl = new URL("../src/session-store.ts", import.meta.url).href;
  const holderScript = `
    import { acquireReviewSessionLock } from ${JSON.stringify(moduleUrl)};
    await acquireReviewSessionLock(${JSON.stringify(storagePath)}, {
      timeoutMs: 2000,
      retryDelayMs: 5,
      lockfPath: "/usr/bin/lockf",
    });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `;
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", holderScript], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (holder.exitCode == null && holder.signalCode == null) holder.kill("SIGKILL");
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => rejectReady(new Error(`lock holder did not become ready: ${stderr}`)), 5_000);
    holder.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (!stdout.includes("ready\n")) return;
      clearTimeout(timeout);
      resolveReady();
    });
    holder.stderr.on("data", (chunk) => { stderr += String(chunk); });
    holder.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`lock holder exited before ready: ${code ?? signal}; ${stderr}`));
    });
  });

  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  await exited;
  const release = await (acquire as (
    path: string,
    options: Record<string, unknown>,
  ) => Promise<() => Promise<void>>)(storagePath, {
    timeoutMs: 2_000,
    retryDelayMs: 5,
    lockfPath: "/usr/bin/lockf",
  });
  await release();
});

test("concurrent dual-lock acquisitions never overlap", async () => {
  const acquire = (sessionStore as Record<string, unknown>).acquireReviewSessionLock;
  assert.equal(typeof acquire, "function");
  if (typeof acquire !== "function") return;

  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-lockf-concurrent-"));
  const storagePath = join(root, "session.json");
  const invoke = acquire as (
    path: string,
    options: Record<string, unknown>,
  ) => Promise<() => Promise<void>>;
  let active = 0;
  let maximumActive = 0;

  await Promise.all(Array.from({ length: 4 }, async () => {
    const release = await invoke(storagePath, {
      timeoutMs: 2_000,
      retryDelayMs: 5,
      lockfPath: "/usr/bin/lockf",
    });
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await delay(20);
    active -= 1;
    await release();
  }));

  assert.equal(maximumActive, 1);
});

test("every persisted save advances a verified record revision and hash", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-revision-"));
  const storagePath = join(root, "session.json");
  const first = await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment()] },
  })) as ReturnType<typeof buildReviewSessionRecord> & { revision: number; recordHash: string };

  assert.equal(first.revision, 1);
  assert.match(first.recordHash, /^[a-f0-9]{64}$/);
  const second = await (saveReviewSession as unknown as (
    path: string,
    record: ReturnType<typeof buildReviewSessionRecord>,
    options: { expectedRecordState: { revision: number; recordHash: string } },
  ) => Promise<typeof first>)(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { overallComment: "new state", comments: [stagedComment()] },
  }), { expectedRecordState: { revision: first.revision, recordHash: first.recordHash } });

  assert.equal(second.revision, 2);
  assert.notEqual(second.recordHash, first.recordHash);
  const tampered = structuredClone(second);
  tampered.snapshot.overallComment = "tampered without updating the hash";
  await writeFile(storagePath, JSON.stringify(tampered), "utf8");
  await assert.rejects(loadReviewSession(storagePath), /invalid|corrupt|incompatible/i);
});

test("a stale ordinary autosave is rejected without deleting a comment staged by another process", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-stale-"));
  const storagePath = join(root, "session.json");
  const base = await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment("base")] },
  })) as ReturnType<typeof buildReviewSessionRecord> & { revision: number; recordHash: string };
  const baseState = { revision: base.revision, recordHash: base.recordHash };
  const saveWithState = saveReviewSession as unknown as (
    path: string,
    record: ReturnType<typeof buildReviewSessionRecord>,
    options: { expectedRecordState: { revision: number; recordHash: string } },
  ) => Promise<ReturnType<typeof buildReviewSessionRecord>>;

  await saveWithState(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment("base"), stagedComment("new-from-process-b")] },
  }), { expectedRecordState: baseState });
  await assert.rejects(saveWithState(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { overallComment: "stale process A progress", comments: [stagedComment("base")] },
  }), { expectedRecordState: baseState }), /record.*changed|revision|hash|compare/i);

  const restored = await loadReviewSession(storagePath);
  assert.equal(restored?.snapshot.overallComment, undefined);
  assert.deepEqual(restored?.snapshot.comments?.map((comment) => comment.id), ["base", "new-from-process-b"]);
});

test("record-level CAS prevents a null-intent ABA from reaching a second POST", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-aba-"));
  const storagePath = join(root, "session.json");
  const source = { ...publishSource, sourceKey: fingerprint.sourceKey };
  const initial = await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment()] },
  })) as ReturnType<typeof buildReviewSessionRecord> & { revision: number; recordHash: string };
  const staleState = { revision: initial.revision, recordHash: initial.recordHash };
  const pending = {
    version: 1 as const,
    status: "pending" as const,
    correlationId: "review-intent-process-b-1234",
    source,
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
    createdAt: "2026-07-10T09:00:00Z",
    updatedAt: "2026-07-10T09:00:00Z",
  };
  const saveWithState = saveReviewSession as unknown as (
    path: string,
    record: ReturnType<typeof buildReviewSessionRecord>,
    options: {
      expectedRecordState: { revision: number; recordHash: string };
      publishIntentTransition: Record<string, unknown>;
    },
  ) => Promise<ReturnType<typeof buildReviewSessionRecord> & { revision: number; recordHash: string }>;
  const processBPending = await saveWithState(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment()], githubPublishIntent: pending },
  }), {
    expectedRecordState: staleState,
    publishIntentTransition: { expected: null, next: pending, expectedRecordState: staleState },
  });
  const processBState = { revision: processBPending.revision, recordHash: processBPending.recordHash };
  await saveWithState(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment()] },
  }), {
    expectedRecordState: processBState,
    publishIntentTransition: { expected: pending, next: null, expectedRecordState: processBState },
  });

  let latest: ReviewSessionSnapshot = initial.snapshot;
  let processAState = staleState;
  const createController = (sessionStore as Record<string, unknown>).createGitHubPublishSessionController;
  const controller = (createController as (options: Record<string, unknown>) => PublishSessionController)({
    source,
    initialIntent: null,
    getSnapshot: () => latest,
    getRecordState: () => processAState,
    persistSnapshot: async (snapshot: ReviewSessionSnapshot, transition: Record<string, any>) => {
      const persisted = await saveWithState(storagePath, buildReviewSessionRecord({
        sourceKey: fingerprint.sourceKey,
        fingerprint,
        analysis,
        snapshot,
      }), {
        expectedRecordState: transition.expectedRecordState ?? processAState,
        publishIntentTransition: transition,
      });
      latest = persisted.snapshot;
      processAState = { revision: persisted.revision, recordHash: persisted.recordHash };
      return true;
    },
    now: () => "2026-07-10T09:30:00Z",
  });
  let remoteWrites = 0;

  await assert.rejects(controller.runPublish({
    correlationId: "review-intent-process-a-1234",
    snapshot: latest,
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async () => {
    remoteWrites += 1;
    return { warnings: [] };
  }), /record|revision|hash|compare|another process|changed/i);
  assert.equal(remoteWrites, 0);
});

test("per-source publish transitions use an interprocess CAS so two controllers make only one remote write", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-cas-"));
  const storagePath = join(root, "session.json");
  const diskPublishSource = { ...publishSource, sourceKey: fingerprint.sourceKey };
  const initial = await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment()] },
  }));
  const initialState = { revision: initial.revision, recordHash: initial.recordHash };

  const createController = (sessionStore as Record<string, unknown>).createGitHubPublishSessionController;
  const saveWithTransition = saveReviewSession as unknown as (
    path: string,
    record: ReturnType<typeof buildReviewSessionRecord>,
    options: { publishIntentTransition: Record<string, unknown> },
  ) => Promise<ReturnType<typeof buildReviewSessionRecord>>;
  const controllers = ["one", "two"].map((name) => {
    let latest: ReviewSessionSnapshot = { comments: [stagedComment()] };
    let recordState = initialState;
    return (createController as (options: Record<string, unknown>) => PublishSessionController)({
      source: diskPublishSource,
      initialIntent: null,
      getSnapshot: () => latest,
      getRecordState: () => recordState,
      persistSnapshot: async (snapshot: ReviewSessionSnapshot, transition: Record<string, any>) => {
        const persisted = await saveWithTransition(storagePath, buildReviewSessionRecord({
          sourceKey: fingerprint.sourceKey,
          fingerprint,
          analysis,
          snapshot,
        }), {
          expectedRecordState: transition.expectedRecordState,
          publishIntentTransition: transition,
        } as never);
        latest = persisted.snapshot;
        recordState = { revision: persisted.revision, recordHash: persisted.recordHash };
        return true;
      },
      now: () => `2026-07-10T09:00:0${name === "one" ? "1" : "2"}Z`,
    });
  });
  let remoteWrites = 0;
  const outcomes = await Promise.allSettled(controllers.map(async (controller, index) => await controller.runPublish({
    correlationId: `review-intent-process-${index + 1}`,
    snapshot: { comments: [stagedComment()] },
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
  }, async (beforePost) => {
    await beforePost();
    remoteWrites += 1;
    return {
      reviewId: 5000 + index,
      reviewUrl: `https://github.com/headout/magellan/pull/646#pullrequestreview-${5000 + index}`,
      submittedAt: "2026-07-10T09:30:00Z",
      warnings: [],
    };
  })));

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.match(String(outcomes.find((outcome) => outcome.status === "rejected")?.reason), /changed|conflict|another process|compare/i);
  assert.equal(remoteWrites, 1);
  const restored = await loadReviewSession(storagePath);
  assert.equal(restored?.snapshot.githubPublishIntent?.status, "confirmed");
});

test("ordinary autosaves preserve a concurrent outstanding intent and receipt-backed publication", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-merge-"));
  const storagePath = join(root, "session.json");
  const diskPublishSource = { ...publishSource, sourceKey: fingerprint.sourceKey };
  const saveWithTransition = saveReviewSession as unknown as (
    path: string,
    record: ReturnType<typeof buildReviewSessionRecord>,
    options?: {
      expectedRecordState?: { revision: number; recordHash: string };
      publishIntentTransition?: Record<string, unknown>;
    },
  ) => Promise<ReturnType<typeof buildReviewSessionRecord>>;
  const pending = {
    version: 1 as const,
    status: "pending" as const,
    correlationId: "review-intent-concurrent-autosave",
    source: diskPublishSource,
    representedCommentIds: ["submitted"],
    submittedComments: [stagedComment()],
    createdAt: "2026-07-10T09:00:00Z",
    updatedAt: "2026-07-10T09:00:00Z",
  };
  const initial = await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment()] },
  }));
  let recordState = { revision: initial.revision, recordHash: initial.recordHash };
  const pendingRecord = await saveWithTransition(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: { comments: [stagedComment()], githubPublishIntent: pending },
  }), {
    expectedRecordState: recordState,
    publishIntentTransition: { expected: null, next: pending, expectedRecordState: recordState },
  });
  recordState = { revision: pendingRecord.revision, recordHash: pendingRecord.recordHash };

  const autosavedRecord = await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: {
      overallComment: "new renderer progress",
      comments: [stagedComment("newer-staged")],
    },
  }), { expectedRecordState: recordState });
  recordState = { revision: autosavedRecord.revision, recordHash: autosavedRecord.recordHash };
  const afterPendingAutosave = await loadReviewSession(storagePath);
  assert.equal(afterPendingAutosave?.snapshot.githubPublishIntent?.correlationId, pending.correlationId);
  assert.equal(afterPendingAutosave?.snapshot.overallComment, "new renderer progress");

  const confirmed = {
    ...pending,
    status: "confirmed" as const,
    updatedAt: "2026-07-10T09:30:00Z",
    receipt: {
      reviewId: 4321,
      reviewUrl: "https://github.com/headout/magellan/pull/646#pullrequestreview-4321",
      submittedAt: "2026-07-10T09:30:00Z",
      warnings: [],
    },
  };
  const confirmedRecord = await saveWithTransition(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: {
      ...(afterPendingAutosave?.snapshot ?? {}),
      githubPublishIntent: confirmed,
    },
  }), {
    expectedRecordState: recordState,
    publishIntentTransition: { expected: pending, next: confirmed, expectedRecordState: recordState },
  });
  recordState = { revision: confirmedRecord.revision, recordHash: confirmedRecord.recordHash };

  await saveReviewSession(storagePath, buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: {
      overallComment: "deferred autosave after window close",
      comments: [stagedComment("after-close")],
    },
  }), { expectedRecordState: recordState });
  const restored = await loadReviewSession(storagePath);
  assert.equal(restored?.snapshot.githubPublishIntent?.status, "confirmed");
  assert.equal(restored?.snapshot.overallComment, "deferred autosave after window close");
  assert.deepEqual(restored?.snapshot.comments?.map((comment) => comment.id), ["after-close", "submitted"]);
  assert.equal(restored?.snapshot.comments?.[1]?.status, "published");
  assert.equal(restored?.snapshot.comments?.[1]?.githubReviewId, 4321);
});
