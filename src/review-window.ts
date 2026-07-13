import { randomBytes, randomUUID } from "node:crypto";
import {
  decodeRendererMessage,
  decodeRendererReady,
  decodeReviewPublishGitHubReviewResultMessage,
  type DecodedRendererMessage,
  type RendererProtocolContext,
} from "./renderer-protocol.js";
import type { ReviewRendererBootstrap, ReviewWindowData } from "./types.js";
import { isGitHubReviewContextSnapshot } from "./session-store.js";

interface ReviewWindowLike {
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "closed", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "ready", listener: () => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  loadFile(path: string): void;
  send(source: string): void;
  show(options: { title: string }): void;
  close(): void;
}

interface ReviewWindowTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: ReviewWindowTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const MAX_PRE_BOOT_MESSAGES = 32;

type RendererCommand = Exclude<DecodedRendererMessage, { type: "renderer-booted" }>;

export interface ReviewWindowControllerOptions {
  window: ReviewWindowLike;
  shellPath: string;
  title: string;
  bootstrap: ReviewWindowData;
  protocol: Omit<RendererProtocolContext, "sessionId" | "capability">;
  presentationReady?: boolean;
  bootTimeoutMs?: number;
  timers?: ReviewWindowTimers;
  onMessage: (message: Exclude<DecodedRendererMessage, { type: "renderer-booted" }>) => void;
  onClosed: () => void;
  onError: (error: Error) => void;
}

function jsonParseExpression(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Review window messages must be JSON-serializable.");
  const stringLiteral = JSON.stringify(serialized)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `JSON.parse(${stringLiteral})`;
}

export class ReviewWindowController {
  #window: ReviewWindowLike;
  #shellPath: string;
  #title: string;
  #bootstrap: ReviewWindowData;
  #protocol: RendererProtocolContext | null;
  #onMessage: ReviewWindowControllerOptions["onMessage"];
  #onClosed: () => void;
  #onError: (error: Error) => void;
  #bootTimeoutMs: number;
  #timers: ReviewWindowTimers;
  #bootTimer: unknown | null = null;
  #started = false;
  #settled = false;
  #rendererReady = false;
  #rendererBooted = false;
  #presentationReady: boolean;
  #presented = false;
  #closeRequested = false;
  #preBootMessages: RendererCommand[] = [];
  #preBootHostMessages: unknown[] = [];

  constructor(options: ReviewWindowControllerOptions) {
    this.#window = options.window;
    this.#shellPath = options.shellPath;
    this.#title = options.title;
    this.#bootstrap = options.bootstrap;
    this.#protocol = {
      ...options.protocol,
      sessionId: randomUUID(),
      capability: randomBytes(32).toString("base64url"),
    };
    this.#onMessage = options.onMessage;
    this.#onClosed = options.onClosed;
    this.#onError = options.onError;
    this.#presentationReady = options.presentationReady ?? true;
    this.#bootTimeoutMs = options.bootTimeoutMs ?? 15_000;
    this.#timers = options.timers ?? defaultTimers;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#window.on("message", this.#handleMessage);
    this.#window.on("closed", this.#handleClosed);
    this.#window.on("error", this.#handleError);
    this.#window.once("ready", this.#handleReady);
    this.#armBootWatchdog("renderer-ready");
  }

  dispose(): void {
    this.#clearBootWatchdog();
    this.#window.removeListener("message", this.#handleMessage);
    this.#window.removeListener("closed", this.#handleClosed);
    this.#window.removeListener("error", this.#handleError);
    this.#window.removeListener("ready", this.#handleReady);
    this.#preBootMessages = [];
    this.#preBootHostMessages = [];
    this.#protocol = null;
    this.#settled = true;
  }

  releasePresentation(): void {
    if (this.#settled) return;
    this.#presentationReady = true;
    this.#presentIfReady();
  }

  sendHostMessage(message: unknown): boolean {
    if (this.#protocol == null) return false;
    if (!this.#rendererBooted) {
      if (this.#preBootHostMessages.length >= MAX_PRE_BOOT_MESSAGES) return false;
      this.#preBootHostMessages.push(message);
      return true;
    }
    let decoded = message;
    if (message != null
      && typeof message === "object"
      && !Array.isArray(message)
      && (message as Record<string, unknown>).type === "github-context-result") {
      const result = message as Record<string, unknown>;
      if (typeof result.requestId !== "string" || result.requestId.length === 0 || typeof result.ok !== "boolean") return false;
      if (result.ok === true) {
        if (!isGitHubReviewContextSnapshot(result.context)) return false;
      } else {
        if (typeof result.message !== "string"
          || (result.cachedContext !== undefined && !isGitHubReviewContextSnapshot(result.cachedContext))) return false;
      }
    }
    if (message != null
      && typeof message === "object"
      && !Array.isArray(message)
      && (message as Record<string, unknown>).type === "publish-github-review-result") {
      decoded = decodeReviewPublishGitHubReviewResultMessage(message, this.#protocol);
      if (decoded == null) return false;
    }
    try {
      this.#window.send(`window.__reviewReceive(${jsonParseExpression(decoded)});`);
      return true;
    } catch (error) {
      this.#handleError(asError(error));
      return false;
    }
  }

  updateProtocolContext(protocol: Omit<RendererProtocolContext, "sessionId" | "capability">): void {
    if (this.#protocol == null) return;
    this.#protocol = {
      ...protocol,
      sessionId: this.#protocol.sessionId,
      capability: this.#protocol.capability,
    };
  }

  #handleReady = (): void => {
    try {
      this.#window.loadFile(this.#shellPath);
    } catch (error) {
      this.#handleError(asError(error));
    }
  };

  #handleMessage = (data: unknown): void => {
    if (this.#protocol == null) return;
    if (!this.#rendererReady) {
      if (decodeRendererReady(data) == null) return;
      this.#rendererReady = true;
      this.#armBootWatchdog("renderer-booted");
      const bootstrap: ReviewRendererBootstrap = {
        protocol: 1,
        sessionId: this.#protocol.sessionId,
        capability: this.#protocol.capability,
        data: this.#bootstrap,
      };
      try {
        this.#window.send(`window.__reviewBootstrap(${jsonParseExpression(bootstrap)});`);
      } catch (error) {
        this.#handleError(asError(error));
      }
      return;
    }

    const message = decodeRendererMessage(data, this.#protocol);
    if (message == null) return;
    if (message.type === "renderer-booted") {
      if (this.#rendererBooted) return;
      this.#rendererBooted = true;
      this.#clearBootWatchdog();
      const queuedMessages = this.#preBootMessages.splice(0);
      for (const queuedMessage of queuedMessages) {
        if (this.#settled || this.#protocol == null) break;
        this.#dispatchMessage(queuedMessage);
      }
      const queuedHostMessages = this.#preBootHostMessages.splice(0);
      for (const queuedMessage of queuedHostMessages) {
        if (this.#settled || this.#protocol == null) break;
        this.sendHostMessage(queuedMessage);
      }
      this.#presentIfReady();
      return;
    }
    if (!this.#rendererBooted) {
      if (this.#preBootMessages.length >= MAX_PRE_BOOT_MESSAGES) {
        this.#handleError(new Error(
          `Review renderer sent more than ${MAX_PRE_BOOT_MESSAGES} commands before completing boot.`,
        ));
        return;
      }
      this.#preBootMessages.push(message);
      return;
    }
    this.#dispatchMessage(message);
  };

  #dispatchMessage(message: RendererCommand): void {
    if (message.type === "submit" || message.type === "cancel") {
      this.#settled = true;
      this.#clearBootWatchdog();
      this.#preBootMessages = [];
      this.#protocol = null;
      this.#closeWindow();
      this.#onMessage(message);
      return;
    }
    this.#onMessage(message);
  }

  #handleClosed = (): void => {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearBootWatchdog();
    this.#preBootMessages = [];
    this.#protocol = null;
    this.#onClosed();
  };

  #handleError = (error: Error): void => {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearBootWatchdog();
    this.#preBootMessages = [];
    this.#protocol = null;
    this.#closeWindow();
    this.#onError(error);
  };

  #closeWindow(): void {
    if (this.#closeRequested) return;
    this.#closeRequested = true;
    try {
      this.#window.close();
    } catch {}
  }

  #presentIfReady(): void {
    if (this.#settled || this.#presented || !this.#rendererBooted || !this.#presentationReady) return;
    try {
      this.#window.show({ title: this.#title });
      this.#presented = true;
    } catch (error) {
      this.#handleError(asError(error));
    }
  }

  #armBootWatchdog(stage: "renderer-ready" | "renderer-booted"): void {
    this.#clearBootWatchdog();
    this.#bootTimer = this.#timers.setTimeout(() => {
      this.#bootTimer = null;
      this.#handleError(new Error(
        `Review renderer timed out after ${this.#bootTimeoutMs} ms waiting for ${stage} while loading ${this.#shellPath}.`,
      ));
    }, this.#bootTimeoutMs);
    if (this.#bootTimer != null && typeof this.#bootTimer === "object" && "unref" in this.#bootTimer) {
      const unref = (this.#bootTimer as { unref?: () => void }).unref;
      unref?.call(this.#bootTimer);
    }
  }

  #clearBootWatchdog(): void {
    if (this.#bootTimer == null) return;
    this.#timers.clearTimeout(this.#bootTimer);
    this.#bootTimer = null;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createReviewWindowController(options: ReviewWindowControllerOptions): ReviewWindowController {
  return new ReviewWindowController(options);
}
