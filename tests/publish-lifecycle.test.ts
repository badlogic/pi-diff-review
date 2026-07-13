import assert from "node:assert/strict";
import test from "node:test";
import { buildGitHubReviewPublishPlan } from "../src/github-publish.js";
import * as reviewIndex from "../src/index.js";
import { runReviewSessionStartupPersistence } from "../src/review-session-startup.js";
import type { ReviewSubmitPayload } from "../src/types.js";

type TerminalMessage = { type: "submit" | "cancel" };

interface HostPublishLifecycle {
  readonly active: boolean;
  readonly terminal: Promise<TerminalMessage | null>;
  readonly callbacks: {
    onRendererClosed(): void;
    onControllerError(error: Error): void;
    onAuthenticatedTerminal(message: TerminalMessage): void;
  };
  startPublish(task: () => Promise<void>): Promise<void> | null;
  persist(): Promise<boolean>;
  onTerminalEscape(): Promise<TerminalMessage | null>;
  onSessionShutdown(): Promise<TerminalMessage | null>;
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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function lifecycleFactory(): (options: {
  closeWindow: () => void;
  persist: () => Promise<boolean>;
  onSettling: () => void;
}) => HostPublishLifecycle {
  const createLifecycle = (reviewIndex as Record<string, unknown>).createReviewHostPublishLifecycle;
  assert.equal(typeof createLifecycle, "function");
  return createLifecycle as ReturnType<typeof lifecycleFactory>;
}

function createHarness() {
  const remote = deferred<void>();
  const durableSave = deferred<void>();
  let publishCount = 0;
  let saveCount = 0;
  let closeCount = 0;
  let settlingCount = 0;
  const lifecycle = lifecycleFactory()({
    closeWindow: () => { closeCount += 1; },
    persist: async () => {
      saveCount += 1;
      await durableSave.promise;
      return true;
    },
    onSettling: () => { settlingCount += 1; },
  });
  const publish = lifecycle.startPublish(async () => {
    publishCount += 1;
    await remote.promise;
    await lifecycle.persist();
  });
  assert.notEqual(publish, null);
  assert.equal(lifecycle.startPublish(async () => { publishCount += 1; }), null);
  return {
    lifecycle,
    publish: publish as Promise<void>,
    remote,
    durableSave,
    recordNativeClose: () => { closeCount += 1; },
    counts: () => ({ publishCount, saveCount, closeCount, settlingCount }),
  };
}

test("every production close/error/shutdown callback drains one in-flight publish and durable save", async (t) => {
  const scenarios: Array<{
    name: string;
    signal: (lifecycle: HostPublishLifecycle) => void | Promise<TerminalMessage | null>;
    controllerClosedWindow: boolean;
    rejects: boolean;
  }> = [
    {
      name: "renderer closed",
      signal: (lifecycle) => lifecycle.callbacks.onRendererClosed(),
      controllerClosedWindow: true,
      rejects: false,
    },
    {
      name: "terminal Escape",
      signal: (lifecycle) => lifecycle.onTerminalEscape(),
      controllerClosedWindow: false,
      rejects: false,
    },
    {
      name: "renderer/controller error",
      signal: (lifecycle) => lifecycle.callbacks.onControllerError(new Error("renderer failed")),
      controllerClosedWindow: true,
      rejects: true,
    },
    {
      name: "session shutdown",
      signal: (lifecycle) => lifecycle.onSessionShutdown(),
      controllerClosedWindow: false,
      rejects: false,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const harness = createHarness();
      if (scenario.controllerClosedWindow) harness.recordNativeClose();
      let completionSettled = false;
      const signalResult = scenario.signal(harness.lifecycle);
      const commandCompletion = signalResult instanceof Promise ? signalResult : harness.lifecycle.terminal;
      const completion = commandCompletion.then(
        (value) => ({ status: "resolved" as const, value }),
        (error) => ({ status: "rejected" as const, error }),
      );
      void completion.then(() => { completionSettled = true; });
      assert.equal(harness.lifecycle.startPublish(async () => {}), null);

      // Native close can synchronously emit closed after Escape/shutdown or race an error callback.
      harness.lifecycle.callbacks.onRendererClosed();
      await flushMicrotasks();
      assert.equal(harness.counts().publishCount, 1);
      assert.equal(completionSettled, false);
      assert.equal(harness.lifecycle.active, true);
      assert.ok(harness.counts().closeCount <= 1);
      assert.equal(harness.counts().settlingCount, 1);

      harness.remote.resolve();
      await flushMicrotasks();
      assert.equal(harness.counts().saveCount, 1);
      assert.equal(completionSettled, false);
      assert.equal(harness.lifecycle.active, true);

      harness.durableSave.resolve();
      await harness.publish;
      const result = await completion;
      assert.equal(result.status, scenario.rejects ? "rejected" : "resolved");
      if (scenario.rejects && result.status === "rejected") {
        assert.match(String(result.error), /renderer failed/);
      }
      assert.equal(harness.lifecycle.active, false);
      assert.deepEqual(harness.counts(), {
        publishCount: 1,
        saveCount: 1,
        closeCount: 1,
        settlingCount: 1,
      });
    });
  }
});

test("authenticated submit and cancel callbacks wait for durable save without closing twice", async (t) => {
  for (const type of ["submit", "cancel"] as const) {
    await t.test(type, async () => {
      const harness = createHarness();
      harness.recordNativeClose();
      const message: TerminalMessage = { type };
      let completionSettled = false;
      harness.lifecycle.callbacks.onAuthenticatedTerminal(message);
      const completion = harness.lifecycle.terminal;
      void completion.then(() => { completionSettled = true; });
      assert.equal(harness.lifecycle.startPublish(async () => {}), null);
      harness.lifecycle.callbacks.onRendererClosed();

      await flushMicrotasks();
      assert.equal(harness.counts().publishCount, 1);
      assert.equal(harness.counts().saveCount, 0);
      assert.equal(completionSettled, false);
      assert.equal(harness.lifecycle.active, true);
      assert.equal(harness.counts().closeCount, 1);

      harness.remote.resolve();
      await flushMicrotasks();
      assert.equal(harness.counts().saveCount, 1);
      assert.equal(completionSettled, false);
      assert.equal(harness.lifecycle.active, true);

      harness.durableSave.resolve();
      await harness.publish;
      assert.deepEqual(await completion, message);
      assert.equal(harness.lifecycle.active, false);
      harness.lifecycle.callbacks.onRendererClosed();
      assert.deepEqual(harness.counts(), {
        publishCount: 1,
        saveCount: 1,
        closeCount: 1,
        settlingCount: 1,
      });
    });
  }
});

test("production host options expose only the explicit ambiguous-intent abandonment flag", () => {
  const extractOptions = (reviewIndex as Record<string, unknown>).extractReviewHostOptions;
  assert.equal(typeof extractOptions, "function");
  if (typeof extractOptions !== "function") return;

  assert.deepEqual(extractOptions([
    "--abandon-ambiguous-publish",
    "pr",
    "https://github.com/headout/magellan/pull/646",
  ]), {
    commandArgs: ["pr", "https://github.com/headout/magellan/pull/646"],
    abandonAmbiguousPublish: true,
  });
  assert.deepEqual(extractOptions(["--reset-review"]), {
    commandArgs: ["--reset-review"],
    abandonAmbiguousPublish: false,
  });
});

test("renderer checkpoints preserve host-owned session state while replacing latest renderer fields", () => {
  const mergeCheckpoint = (reviewIndex as Record<string, unknown>).mergeRendererSessionCheckpoint;
  assert.equal(typeof mergeCheckpoint, "function");
  if (typeof mergeCheckpoint !== "function") return;
  const hostAnalysis = { status: "ready", marker: "host-owned" };
  const publishIntent = { status: "ambiguous", marker: "host-owned" };
  const githubContext = { owner: "headout", repo: "magellan", marker: "host-owned" };

  const merged = (mergeCheckpoint as (current: Record<string, unknown>, checkpoint: Record<string, unknown>) => Record<string, unknown>)({
    analysis: hostAnalysis,
    githubPublishIntent: publishIntent,
    githubContext,
    overallComment: "old",
    comments: [{ id: "comment", body: "old" }],
  }, {
    overallComment: "latest",
    comments: [{ id: "comment", body: "latest typed text" }],
    githubContext: { owner: "attacker", marker: "renderer-controlled" },
  });

  assert.equal(merged.analysis, hostAnalysis);
  assert.equal(merged.githubPublishIntent, publishIntent);
  assert.equal(merged.githubContext, githubContext);
  assert.equal(merged.overallComment, "latest");
  assert.deepEqual(merged.comments, [{ id: "comment", body: "latest typed text" }]);
});

test("stale confirmed intent retirement fails closed without a record revision and hash", async () => {
  const callbacks: string[] = [];
  await assert.rejects(runReviewSessionStartupPersistence({
    confirmedIntent: {
      version: 1,
      status: "confirmed",
      correlationId: "review-intent-lifecycle-retirement",
      source: {
        sourceKey: "github:headout/magellan:pull/646",
        owner: "headout",
        repo: "magellan",
        pullNumber: 646,
        reviewedHeadSha: "old-head",
      },
      representedCommentIds: [],
      submittedComments: [],
      createdAt: "2026-07-10T09:00:00Z",
      updatedAt: "2026-07-10T09:30:00Z",
      receipt: { warnings: [] },
    },
    snapshot: {},
    recordState: null,
    persistConfirmedRetirement: async () => {
      callbacks.push("retire");
      throw new Error("must not run");
    },
    initializeRuntime: async () => { callbacks.push("initialize"); },
    persistInitialSnapshot: async () => { callbacks.push("ordinary-save"); return true; },
  }), /revision|hash|record state/i);
  assert.deepEqual(callbacks, []);
});

test("review startup fails closed when the initial durable snapshot save is rejected", async () => {
  const callbacks: string[] = [];
  await assert.rejects((runReviewSessionStartupPersistence as unknown as (
    options: Record<string, unknown>,
  ) => Promise<void>)({
    confirmedIntent: null,
    snapshot: {},
    recordState: null,
    persistConfirmedRetirement: async () => {
      throw new Error("must not run");
    },
    initializeRuntime: async () => { callbacks.push("initialize"); },
    persistInitialSnapshot: async () => {
      callbacks.push("initial-save");
      return false;
    },
  }), /initial.*session.*save|durably save/i);
  assert.deepEqual(callbacks, ["initialize", "initial-save"]);
});

test("production open-time reconciliation keeps an ambiguous review readable and reports its publish block", async () => {
  const reconcileForOpen = (reviewIndex as Record<string, unknown>).reconcileGitHubPublishForReviewOpen;
  assert.equal(typeof reconcileForOpen, "function");
  if (typeof reconcileForOpen !== "function") return;

  const warnings: string[] = [];
  const result = await (reconcileForOpen as (options: Record<string, unknown>) => Promise<{ status: string }>)({
    controller: {
      reconcileOutstanding: async () => ({
        status: "blocked",
        warning: "The prior GitHub publish remains ambiguous; publishing is blocked.",
      }),
      abandonOutstanding: async () => {
        throw new Error("abandonment was not requested");
      },
    },
    reconcileRemote: async () => null,
    abandonAmbiguousPublish: false,
    warn: (message: string) => { warnings.push(message); },
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(warnings, ["The prior GitHub publish remains ambiguous; publishing is blocked."]);
});

test("production open-time reconciliation failures keep review readable and block publishing", async () => {
  const reconcileForOpen = (reviewIndex as Record<string, unknown>).reconcileGitHubPublishForReviewOpen;
  assert.equal(typeof reconcileForOpen, "function");
  if (typeof reconcileForOpen !== "function") return;

  const warnings: string[] = [];
  const result = await (reconcileForOpen as (options: Record<string, unknown>) => Promise<{ status: string; warning?: string }>)({
    controller: {
      reconcileOutstanding: async () => {
        throw new Error("GitHub is temporarily unavailable");
      },
      abandonOutstanding: async () => ({ status: "none" }),
    },
    reconcileRemote: async () => null,
    abandonAmbiguousPublish: false,
    warn: (message: string) => { warnings.push(message); },
  });

  assert.equal(result.status, "blocked");
  assert.match(result.warning ?? "", /reconciliation.*temporarily unavailable.*review can continue.*publishing is blocked/i);
  assert.deepEqual(warnings, [result.warning]);
});

test("production open-time abandonment is explicit and surfaces duplicate risk", async () => {
  const reconcileForOpen = (reviewIndex as Record<string, unknown>).reconcileGitHubPublishForReviewOpen;
  assert.equal(typeof reconcileForOpen, "function");
  if (typeof reconcileForOpen !== "function") return;

  const events: string[] = [];
  const result = await (reconcileForOpen as (options: Record<string, unknown>) => Promise<{ status: string }>)({
    controller: {
      abandonOutstanding: async () => {
        events.push("abandon");
        return {
          status: "abandoned",
          warning: "Retrying can create a duplicate GitHub review.",
        };
      },
      reconcileOutstanding: async () => {
        events.push("reconcile");
        return { status: "none" };
      },
    },
    reconcileRemote: async () => null,
    abandonAmbiguousPublish: true,
    warn: (message: string) => { events.push(`warn:${message}`); },
  });

  assert.equal(result.status, "none");
  assert.deepEqual(events, [
    "abandon",
    "warn:Retrying can create a duplicate GitHub review.",
    "reconcile",
  ]);
});

test("the production pre-POST hook reloads, revalidates, and accepts the record before marking ambiguous", async () => {
  const prepare = (reviewIndex as Record<string, unknown>).prepareGitHubPublishPost;
  assert.equal(typeof prepare, "function");
  if (typeof prepare !== "function") return;

  const submit: ReviewSubmitPayload = {
    type: "submit",
    overallComment: "Review body",
    comments: [{
      id: "comment-1",
      fileId: "file-1",
      scope: "git-diff",
      side: "modified",
      startLine: 4,
      endLine: null,
      body: "Original submitted body.",
    }],
    acceptedFindings: [],
    findingStatuses: [],
    approvalPacket: {
      summary: "Summary",
      reviewedChapters: [],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "Packet",
    },
  };
  const originalOptions = {
    event: "COMMENT" as const,
    body: "Review body",
    submit,
    filePathById: new Map([["file-1", "src/file.ts"]]),
    commentableLinesByFileId: new Map([["file-1", { original: [], modified: [{ start: 1, end: 8 }] }]]),
    reviewedHeadSha: "reviewed-head-sha",
    correlationId: "review-intent-prepost-1234",
  };
  const expectedPlan = buildGitHubReviewPublishPlan(originalOptions);
  const record = {
    revision: 2,
    recordHash: "a".repeat(64),
    snapshot: { overallComment: submit.overallComment, comments: submit.comments },
  };
  const events: string[] = [];
  const invoke = prepare as (options: Record<string, unknown>) => Promise<void>;

  await invoke({
    loadPersistedSession: async () => { events.push("load"); return record; },
    expectedPlan,
    originalOptions,
    acceptPersistedRecord: () => { events.push("accept"); },
    markPostStarting: async () => { events.push("mark-ambiguous"); },
  });
  assert.deepEqual(events, ["load", "accept", "mark-ambiguous"]);

  events.length = 0;
  await assert.rejects(invoke({
    loadPersistedSession: async () => {
      events.push("load");
      return {
        ...record,
        snapshot: {
          ...record.snapshot,
          comments: [{ ...submit.comments[0]!, body: "Changed persisted draft." }],
        },
      };
    },
    expectedPlan,
    originalOptions,
    acceptPersistedRecord: () => { events.push("accept"); },
    markPostStarting: async () => { events.push("mark-ambiguous"); },
  }), /changed|latest draft|persisted/i);
  assert.deepEqual(events, ["load"]);
});
