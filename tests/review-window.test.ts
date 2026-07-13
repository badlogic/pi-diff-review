import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createReviewWindowController } from "../src/review-window.js";
import type { RendererProtocolContext } from "../src/renderer-protocol.js";

class FakeWindow extends EventEmitter {
  readonly calls: string[] = [];
  readonly sent: string[] = [];
  readonly shown: Array<{ title?: string }> = [];
  readonly presentationEvents: string[] = [];
  closeCount = 0;

  override on(event: string, listener: (...args: any[]) => void): this {
    this.calls.push(`on:${event}`);
    return super.on(event, listener);
  }

  override once(event: string, listener: (...args: any[]) => void): this {
    this.calls.push(`once:${event}`);
    return super.once(event, listener);
  }

  loadFile(path: string): void {
    this.calls.push(`loadFile:${path}`);
  }

  send(source: string): void {
    this.sent.push(source);
    this.presentationEvents.push("send");
  }

  show(options: { title?: string }): void {
    this.shown.push(options);
    this.presentationEvents.push("show");
  }

  close(): void {
    this.closeCount += 1;
  }
}

class FakeTimers {
  readonly delays: number[] = [];
  #nextId = 1;
  #callbacks = new Map<number, () => void>();

  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.#nextId++;
    this.delays.push(delay);
    this.#callbacks.set(id, callback);
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.#callbacks.delete(handle as number);
  };

  runAll(): void {
    const callbacks = [...this.#callbacks.entries()];
    this.#callbacks.clear();
    for (const [, callback] of callbacks) callback();
  }

  get pending(): number {
    return this.#callbacks.size;
  }
}

const protocol: Omit<RendererProtocolContext, "sessionId" | "capability"> = {
  files: new Map([["file-1", { scopes: new Set(["git-diff"]), commitShas: new Set() }]]),
  commitShas: new Set(),
  findingIds: new Set(),
  chapterIds: new Set(),
};

function frame(context: RendererProtocolContext, message: Record<string, unknown>): Record<string, unknown> {
  return { protocol: 1, sessionId: context.sessionId, capability: context.capability, message };
}

function bootstrapFrom(source: string): { sessionId: string; capability: string; data: { title: string } } {
  return injectedValueFrom(source, "__reviewBootstrap");
}

function injectedValueFrom<T>(source: string, method: "__reviewBootstrap" | "__reviewReceive"): T {
  let injected: T | undefined;
  const receiver = { [method]: (value: T) => { injected = value; } };
  Function("window", source)(receiver);
  assert.notEqual(injected, undefined);
  return injected as T;
}

test("attaches listeners before loading the static shell and waits for boot before show", () => {
  const window = new FakeWindow();
  const dispatched: string[] = [];
  const controller = createReviewWindowController({
    window,
    shellPath: "/package with spaces/web/index.html",
    title: "Diff review",
    bootstrap: { title: "Review data" } as never,
    protocol,
    onMessage: (message) => dispatched.push(message.type),
    onClosed: () => dispatched.push("closed"),
    onError: () => dispatched.push("error"),
  });

  controller.start();
  assert.deepEqual(window.calls, ["on:message", "on:closed", "on:error", "once:ready", "on:ready"]);
  assert.equal(controller.sendHostMessage({ type: "review-map-progress", progress: { phase: "scout", message: "Scanning" } }), true);
  window.emit("ready");
  assert.deepEqual(window.calls, ["on:message", "on:closed", "on:error", "once:ready", "on:ready", "loadFile:/package with spaces/web/index.html"]);
  assert.equal(window.shown.length, 0);

  window.emit("message", { type: "renderer-ready" });
  assert.equal(window.sent.length, 1);
  const bootstrap = bootstrapFrom(window.sent[0]);
  assert.match(bootstrap.sessionId, /^[0-9a-f-]{36}$/);
  assert.match(bootstrap.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(bootstrap.data, { title: "Review data" });
  assert.equal(window.shown.length, 0);

  const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  window.emit("message", frame(context, { type: "renderer-booted" }));
  assert.deepEqual(window.shown, [{ title: "Diff review" }]);
  assert.deepEqual(dispatched, []);
  assert.match(window.sent[1], /^window\.__reviewReceive\(/);
  assert.equal(controller.sendHostMessage({ type: "file-data" }), true);
  assert.match(window.sent[2], /^window\.__reviewReceive\(/);

  window.emit("message", frame(context, { type: "request-file", requestId: "request-1", fileId: "file-1", scope: "git-diff" }));
  assert.deepEqual(dispatched, ["request-file"]);
});

test("defers presentation until a booted renderer is released", () => {
  const window = new FakeWindow();
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    presentationReady: false,
    onMessage: () => {},
    onClosed: () => {},
    onError: () => {},
  });

  controller.start();
  window.emit("message", { type: "renderer-ready" });
  const bootstrap = bootstrapFrom(window.sent[0]);
  const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  window.emit("message", frame(context, { type: "renderer-booted" }));

  assert.deepEqual(window.shown, []);
  controller.releasePresentation();
  controller.releasePresentation();
  assert.deepEqual(window.shown, [{ title: "Diff review" }]);
});

test("delivers queued host state before presenting a renderer released before boot", () => {
  const window = new FakeWindow();
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    presentationReady: false,
    onMessage: () => {},
    onClosed: () => {},
    onError: () => {},
  });

  controller.start();
  assert.equal(controller.sendHostMessage({ type: "review-map-result", map: {} }), true);
  controller.releasePresentation();
  assert.deepEqual(window.shown, []);

  window.emit("message", { type: "renderer-ready" });
  const bootstrap = bootstrapFrom(window.sent[0]);
  const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  window.emit("message", frame(context, { type: "renderer-booted" }));
  assert.deepEqual(window.shown, [{ title: "Diff review" }]);
  assert.deepEqual(window.presentationEvents.slice(-2), ["send", "show"]);

  controller.dispose();
  controller.releasePresentation();
  assert.equal(window.shown.length, 1);
});

test("host injection rejects malformed GitHub context results", () => {
  const window = new FakeWindow();
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    onMessage: () => {},
    onClosed: () => {},
    onError: () => {},
  });
  controller.start();
  window.emit("message", { type: "renderer-ready" });
  const bootstrap = bootstrapFrom(window.sent[0]);
  const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  window.emit("message", frame(context, { type: "renderer-booted" }));

  assert.equal(controller.sendHostMessage({ type: "github-context-result", requestId: "context-1", ok: true, context: { owner: "broken" } }), false);
  assert.equal(controller.sendHostMessage({
    type: "github-context-result",
    requestId: "context-1",
    ok: true,
    context: {
      owner: "headout", repo: "magellan", pullNumber: 646,
      reviewedHeadSha: "head", remoteHeadSha: "head", fetchedAt: "2026-07-10T12:00:00Z",
      conversationComments: [], reviews: [], threads: [], diagnostics: [],
    },
  }), true);
});

test("queues authenticated commands until renderer boot completes", () => {
  const window = new FakeWindow();
  const dispatched: string[] = [];
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    onMessage: (message) => dispatched.push(message.type),
    onClosed: () => {},
    onError: () => {},
  });

  controller.start();
  window.emit("message", { type: "renderer-ready" });
  const bootstrap = bootstrapFrom(window.sent[0]);
  const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  window.emit("message", frame(context, {
    type: "request-file",
    requestId: "initial-file",
    fileId: "file-1",
    scope: "git-diff",
  }));
  assert.deepEqual(dispatched, []);

  window.emit("message", frame(context, { type: "renderer-booted" }));
  assert.deepEqual(dispatched, ["request-file"]);
  assert.deepEqual(window.shown, [{ title: "Diff review" }]);
});

test("bootstrap injection preserves reserved own keys and escaped text through JSON.parse", () => {
  const window = new FakeWindow();
  const bootstrapData = { title: "</script> & \u2028 \u2029" };
  Object.defineProperty(bootstrapData, "__proto__", {
    value: { marker: "bootstrap-reserved-key" },
    enumerable: true,
  });
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: bootstrapData as never,
    protocol,
    onMessage: () => {},
    onClosed: () => {},
    onError: () => {},
  });

  controller.start();
  window.emit("message", { type: "renderer-ready" });

  assert.match(window.sent[0], /^window\.__reviewBootstrap\(JSON\.parse\(/);
  const bootstrap = bootstrapFrom(window.sent[0]);
  assert.equal(Object.hasOwn(bootstrap.data, "__proto__"), true);
  assert.deepEqual((bootstrap.data as unknown as Record<string, unknown>)["__proto__"], { marker: "bootstrap-reserved-key" });
  assert.equal(bootstrap.data.title, "</script> & \u2028 \u2029");
});

test("host injection preserves reserved own keys and escaped text through JSON.parse", () => {
  const window = new FakeWindow();
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    onMessage: () => {},
    onClosed: () => {},
    onError: () => {},
  });
  controller.start();
  window.emit("message", { type: "renderer-ready" });
  const bootstrap = bootstrapFrom(window.sent[0]);
  const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  window.emit("message", frame(context, { type: "renderer-booted" }));
  const hostMessage = { type: "file-error", message: "</script> & \u2028 \u2029" };
  Object.defineProperty(hostMessage, "__proto__", {
    value: { marker: "host-reserved-key" },
    enumerable: true,
  });

  assert.equal(controller.sendHostMessage(hostMessage), true);
  assert.match(window.sent[1], /^window\.__reviewReceive\(JSON\.parse\(/);
  const received = injectedValueFrom<Record<string, unknown>>(window.sent[1], "__reviewReceive");
  assert.equal(Object.hasOwn(received, "__proto__"), true);
  assert.deepEqual(received["__proto__"], { marker: "host-reserved-key" });
  assert.equal(received.message, "</script> & \u2028 \u2029");
});

test("the production host send hook rejects publish success without authoritative comments", () => {
  const window = new FakeWindow();
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    onMessage: () => {},
    onClosed: () => {},
    onError: () => {},
  });
  controller.start();
  window.emit("message", { type: "renderer-ready" });
  const bootstrap = bootstrapFrom(window.sent[0]);
  const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  window.emit("message", frame(context, { type: "renderer-booted" }));

  assert.equal(controller.sendHostMessage({
    type: "publish-github-review-result",
    requestId: "request",
    ok: true,
    message: "Submitted.",
    publishedCommentIds: ["comment-1"],
    submittedAt: "2026-07-10T09:00:00Z",
    warnings: [],
  }), false);
  assert.equal(window.sent.length, 1);

  assert.equal(controller.sendHostMessage({
    type: "publish-github-review-result",
    requestId: "request",
    ok: true,
    message: "Submitted.",
    publishedCommentIds: ["comment-1"],
    publishedComments: [{
      id: "comment-1",
      fileId: "file-1",
      scope: "git-diff",
      side: "modified",
      startLine: 2,
      endLine: null,
      body: "Authoritative body.",
      status: "published",
      published: true,
      publishedAt: "2026-07-10T09:00:00Z",
    }],
    submittedAt: "2026-07-10T09:00:00Z",
    warnings: [],
  }), true);
  const received = injectedValueFrom<Record<string, unknown>>(window.sent[1], "__reviewReceive");
  assert.equal((received.publishedComments as Array<Record<string, unknown>>)[0]?.body, "Authoritative body.");
});

test("rejected, pre-bootstrap, and stale messages produce no privileged dispatch", () => {
  const window = new FakeWindow();
  let effects = 0;
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    onMessage: () => { effects += 1; },
    onClosed: () => { effects += 100; },
    onError: () => { effects += 100; },
  });

  controller.start();
  window.emit("message", { type: "cancel" });
  window.emit("message", { type: "renderer-booted" });
  assert.equal(effects, 0);
  assert.equal(window.shown.length, 0);

  window.emit("message", { type: "renderer-ready" });
  const bootstrap = bootstrapFrom(window.sent[0]);
  const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  const rejectedMessages = [
    { ...frame(context, { type: "cancel" }), capability: "stale" },
    frame(context, { type: "cancel", extra: true }),
    frame(context, { type: "request-file", requestId: "request", fileId: "missing", scope: "git-diff" }),
    frame(context, { type: "run-ai-review", requestId: "ai", extra: true }),
    frame(context, { type: "save-session", snapshot: { activeFileId: "missing" } }),
    frame(context, { type: "submit", overallComment: "missing nested fields" }),
    frame(context, { type: "publish-github-review", requestId: "publish", event: "MERGE", body: "bad", submit: {} }),
  ];
  for (const message of rejectedMessages) window.emit("message", message);
  assert.equal(effects, 0);

  window.emit("closed");
  assert.equal(effects, 100);
  window.emit("message", frame(context, { type: "cancel" }));
  assert.equal(effects, 100);
});

test("aggregate-oversized submit and save messages have zero privileged effects", () => {
  const findingIds = Array.from({ length: 90 }, (_, index) => `finding-${index}`);
  const largeProtocol = { ...protocol, findingIds: new Set(findingIds) };
  const window = new FakeWindow();
  let effects = 0;
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol: largeProtocol,
    onMessage: () => { effects += 1; },
    onClosed: () => {},
    onError: () => {},
  });

  controller.start();
  window.emit("message", { type: "renderer-ready" });
  const bootstrap = bootstrapFrom(window.sent[0]);
  const context: RendererProtocolContext = { ...largeProtocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  window.emit("message", frame(context, { type: "renderer-booted" }));

  const oversizedSubmit = {
    type: "submit",
    overallComment: "Summary",
    comments: Array.from({ length: 90 }, (_, index) => ({
      id: `comment-${index}`,
      fileId: "file-1",
      scope: "git-diff",
      side: "modified",
      startLine: 1,
      endLine: null,
      body: "x".repeat(100_000),
    })),
    acceptedFindings: [],
    findingStatuses: [],
    approvalPacket: {
      summary: "Summary",
      reviewedChapters: [],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "Body",
    },
  };
  const oversizedSave = {
    type: "save-session",
    snapshot: {
      acceptedFindingComments: Object.fromEntries(findingIds.map((findingId) => [findingId, "x".repeat(100_000)])),
    },
  };
  window.emit("message", frame(context, oversizedSubmit));
  window.emit("message", frame(context, oversizedSave));

  assert.equal(effects, 0);
});

test("boot watchdog reports a missing renderer-ready handshake through the error path", () => {
  const window = new FakeWindow();
  const timers = new FakeTimers();
  const errors: Error[] = [];
  const controller = createReviewWindowController({
    window,
    shellPath: "/package/web/index.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    bootTimeoutMs: 25,
    timers,
    onMessage: () => {},
    onClosed: () => {},
    onError: (error) => errors.push(error),
  });

  controller.start();
  assert.equal(timers.pending, 1);
  timers.runAll();

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /renderer-ready/);
  assert.match(errors[0].message, /25 ms/);
  assert.match(errors[0].message, /\/package\/web\/index\.html/);
  assert.equal(window.closeCount, 1);
  window.emit("message", { type: "renderer-ready" });
  window.emit("error", new Error("late error"));
  window.emit("closed");
  assert.equal(window.sent.length, 0);
  assert.equal(window.closeCount, 1);
});

test("boot watchdog distinguishes a missing renderer-booted handshake", () => {
  const window = new FakeWindow();
  const timers = new FakeTimers();
  const errors: Error[] = [];
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    bootTimeoutMs: 40,
    timers,
    onMessage: () => {},
    onClosed: () => {},
    onError: (error) => errors.push(error),
  });

  controller.start();
  window.emit("message", { type: "renderer-ready" });
  assert.equal(timers.pending, 1);
  timers.runAll();

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /renderer-booted/);
  assert.match(errors[0].message, /40 ms/);
  assert.equal(window.shown.length, 0);
  assert.equal(window.closeCount, 1);
  window.emit("error", new Error("late error"));
  window.emit("closed");
  assert.equal(window.closeCount, 1);
});

test("native controller errors close the captured window exactly once", () => {
  const window = new FakeWindow();
  const errors: Error[] = [];
  let closedEffects = 0;
  const controller = createReviewWindowController({
    window,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    onMessage: () => {},
    onClosed: () => { closedEffects += 1; },
    onError: (error) => errors.push(error),
  });

  controller.start();
  window.emit("error", new Error("controller failed"));
  window.emit("error", new Error("duplicate error"));
  window.emit("closed");
  controller.dispose();

  assert.equal(window.closeCount, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /controller failed/);
  assert.equal(closedEffects, 0);
});

test("native window method exceptions enter the error lifecycle exactly once", async (t) => {
  const stages = ["loadFile", "bootstrap-send", "show", "host-send"] as const;
  for (const stage of stages) {
    await t.test(stage, () => {
      const window = new FakeWindow();
      const errors: Error[] = [];
      const controller = createReviewWindowController({
        window,
        shellPath: "/shell.html",
        title: "Diff review",
        bootstrap: {} as never,
        protocol,
        onMessage: () => {},
        onClosed: () => {},
        onError: (error) => errors.push(error),
      });
      controller.start();

      if (stage === "loadFile") {
        window.loadFile = () => { throw new Error("loadFile failed"); };
        assert.doesNotThrow(() => window.emit("ready"));
      } else {
        if (stage === "bootstrap-send") window.send = () => { throw new Error("bootstrap send failed"); };
        assert.doesNotThrow(() => window.emit("message", { type: "renderer-ready" }));
        if (stage !== "bootstrap-send") {
          const bootstrap = bootstrapFrom(window.sent[0]);
          const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
          if (stage === "show") window.show = () => { throw new Error("show failed"); };
          assert.doesNotThrow(() => window.emit("message", frame(context, { type: "renderer-booted" })));
          if (stage === "host-send") {
            window.send = () => { throw new Error("host send failed"); };
            assert.equal(controller.sendHostMessage({ type: "file-error", message: "failed" }), false);
          }
        }
      }

      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /failed/);
      assert.equal(window.closeCount, 1);
      window.emit("closed");
      assert.equal(errors.length, 1);
    });
  }
});

test("authenticated terminal messages close and dispatch exactly once", async (t) => {
  const terminalMessages = [
    { type: "cancel" },
    {
      type: "submit",
      overallComment: "",
      comments: [],
      acceptedFindings: [],
      findingStatuses: [],
      approvalPacket: {
        summary: "",
        reviewedChapters: [],
        acceptedRisks: [],
        unresolvedFindings: [],
        suggestedVerdict: "comment",
        body: "",
      },
    },
  ];

  for (const terminalMessage of terminalMessages) {
    await t.test(terminalMessage.type, () => {
      const window = new FakeWindow();
      const dispatched: string[] = [];
      let closedEffects = 0;
      const controller = createReviewWindowController({
        window,
        shellPath: "/shell.html",
        title: "Diff review",
        bootstrap: {} as never,
        protocol,
        onMessage: (message) => dispatched.push(message.type),
        onClosed: () => { closedEffects += 1; },
        onError: () => {},
      });
      controller.start();
      window.emit("message", { type: "renderer-ready" });
      const bootstrap = bootstrapFrom(window.sent[0]);
      const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
      window.emit("message", frame(context, { type: "renderer-booted" }));

      const terminalFrame = frame(context, terminalMessage);
      window.emit("message", terminalFrame);
      window.emit("message", terminalFrame);
      window.emit("closed");
      controller.dispose();

      assert.equal(window.closeCount, 1);
      assert.deepEqual(dispatched, [terminalMessage.type]);
      assert.equal(closedEffects, 0);
    });
  }
});

test("boot watchdog is cancelled after renderer boot and window close", () => {
  const successWindow = new FakeWindow();
  const successTimers = new FakeTimers();
  const successErrors: Error[] = [];
  const successController = createReviewWindowController({
    window: successWindow,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    bootTimeoutMs: 50,
    timers: successTimers,
    onMessage: () => {},
    onClosed: () => {},
    onError: (error) => successErrors.push(error),
  });
  successController.start();
  successWindow.emit("message", { type: "renderer-ready" });
  const bootstrap = bootstrapFrom(successWindow.sent[0]);
  const context: RendererProtocolContext = { ...protocol, sessionId: bootstrap.sessionId, capability: bootstrap.capability };
  successWindow.emit("message", frame(context, { type: "renderer-booted" }));
  assert.equal(successTimers.pending, 0);
  successTimers.runAll();
  assert.deepEqual(successErrors, []);

  const closedWindow = new FakeWindow();
  const closedTimers = new FakeTimers();
  const closedErrors: Error[] = [];
  const closedController = createReviewWindowController({
    window: closedWindow,
    shellPath: "/shell.html",
    title: "Diff review",
    bootstrap: {} as never,
    protocol,
    bootTimeoutMs: 50,
    timers: closedTimers,
    onMessage: () => {},
    onClosed: () => {},
    onError: (error) => closedErrors.push(error),
  });
  closedController.start();
  closedWindow.emit("closed");
  assert.equal(closedTimers.pending, 0);
  closedTimers.runAll();
  assert.deepEqual(closedErrors, []);
});
