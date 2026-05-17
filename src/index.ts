import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { getReviewWindowData, loadReviewFileContents } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  ReviewCancelPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { buildReviewHtml } from "./ui.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

type WaitingEditorResult = "escape" | "window-settled";

type ReviewMode = "native" | "web";

interface DiffReviewCommandOptions {
  mode: ReviewMode;
  host: string;
  port: number | null;
}

interface ParsedDiffReviewCommand {
  options: DiffReviewCommandOptions;
  showHelp: boolean;
}

interface WebReviewSession {
  url: string;
  tokenPath: string;
  waitForTerminalMessage: Promise<ReviewSubmitPayload | ReviewCancelPayload | null>;
  close: () => Promise<void>;
}

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function normalizeCommandArgs(rawArgs: unknown): string[] {
  if (Array.isArray(rawArgs)) {
    return rawArgs.map((value) => String(value));
  }

  if (typeof rawArgs === "string") {
    return rawArgs
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  if (rawArgs != null && typeof rawArgs === "object") {
    const maybeArgs = (rawArgs as { args?: unknown }).args;
    if (Array.isArray(maybeArgs)) {
      return maybeArgs.map((value) => String(value));
    }
  }

  return [];
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port '${value}'. Use a value between 1 and 65535.`);
  }
  return parsed;
}

function parseDiffReviewCommand(rawArgs: unknown): ParsedDiffReviewCommand {
  const args = normalizeCommandArgs(rawArgs);

  const envMode = process.env.PI_DIFF_REVIEW_WEB === "1" ? "web" : "native";
  const envHost = process.env.PI_DIFF_REVIEW_HOST?.trim() || "127.0.0.1";
  const envPort = process.env.PI_DIFF_REVIEW_PORT?.trim();

  let mode: ReviewMode = envMode;
  let host = envHost;
  let port: number | null = envPort != null && envPort.length > 0 ? parsePort(envPort) : null;
  let showHelp = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--web") {
      mode = "web";
      continue;
    }

    if (arg === "--native") {
      mode = "native";
      continue;
    }

    if (arg === "--public") {
      host = "0.0.0.0";
      continue;
    }

    if (arg === "--port") {
      const value = args[index + 1];
      if (value == null) {
        throw new Error("Missing value after --port.");
      }
      port = parsePort(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      continue;
    }

    if (arg === "--host") {
      const value = args[index + 1];
      if (value == null) {
        throw new Error("Missing value after --host.");
      }
      host = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }

    throw new Error(`Unknown option '${arg}'. Use --help for usage.`);
  }

  return {
    options: {
      mode,
      host,
      port,
    },
    showHelp,
  };
}

function diffReviewUsageLines(): string[] {
  return [
    "Usage: /diff-review [--web] [--native] [--port <n>] [--host <addr>] [--public]",
    "Examples:",
    "  /diff-review",
    "  /diff-review --web",
    "  /diff-review --web --port 8787",
    "  /diff-review --web --host 0.0.0.0 --port 8787",
    "Environment:",
    "  PI_DIFF_REVIEW_WEB=1",
    "  PI_DIFF_REVIEW_HOST=127.0.0.1",
    "  PI_DIFF_REVIEW_PORT=8787",
  ];
}

function showWaitingUI(
  ctx: ExtensionCommandContext,
  title: string,
  bodyLines: string[],
): {
  promise: Promise<WaitingEditorResult>;
  dismiss: () => void;
} {
  let settled = false;
  let doneFn: ((result: WaitingEditorResult) => void) | null = null;
  let pendingResult: WaitingEditorResult | null = null;

  const finish = (result: WaitingEditorResult): void => {
    if (settled) return;
    settled = true;
    if (activeWaitingUIDismiss === dismiss) {
      activeWaitingUIDismiss = null;
    }
    if (doneFn != null) {
      doneFn(result);
    } else {
      pendingResult = result;
    }
  };

  const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
    doneFn = done;
    if (pendingResult != null) {
      const result = pendingResult;
      pendingResult = null;
      queueMicrotask(() => done(result));
    }

    return {
      render(width: number): string[] {
        const innerWidth = Math.max(24, width - 2);
        const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
        const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
        const lines = [theme.fg("accent", theme.bold(title)), ...bodyLines];
        return [
          borderTop,
          ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
          borderBottom,
        ];
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
          finish("escape");
        }
      },
      invalidate(): void {},
    };
  });

  const dismiss = (): void => {
    finish("window-settled");
  };

  activeWaitingUIDismiss = dismiss;

  return {
    promise,
    dismiss,
  };
}

function buildWebBridgeScript(basePath: string): string {
  const encodedBasePath = JSON.stringify(basePath);
  return `
(() => {
  const basePath = ${encodedBasePath};
  const queued = Array.isArray(window.__reviewReceiveQueue) ? window.__reviewReceiveQueue : [];
  window.__reviewReceiveQueue = queued;
  let completed = false;

  function flushQueue() {
    if (typeof window.__reviewReceive !== "function") return;
    while (queued.length > 0) {
      const message = queued.shift();
      window.__reviewReceive(message);
    }
  }

  async function postMessage(payload) {
    try {
      await fetch(basePath + "/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error("[diff-review] failed to post message", error);
    }
  }

  function connectEvents() {
    const stream = new EventSource(basePath + "/events");
    stream.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        queued.push(message);
        flushQueue();
      } catch (error) {
        console.error("[diff-review] failed to parse event", error);
      }
    };

    stream.onerror = () => {
      try {
        stream.close();
      } catch {}
      if (!completed) {
        window.setTimeout(connectEvents, 1000);
      }
    };
  }

  connectEvents();

  window.glimpse = {
    send(payload) {
      if (payload != null && (payload.type === "submit" || payload.type === "cancel")) {
        completed = true;
      }
      void postMessage(payload);
    },
    close() {
      try {
        window.close();
      } catch {}
    },
  };

  window.setInterval(flushQueue, 50);
})();
`;
}

function formatHostForUrl(host: string): string {
  if (host.includes(":")) {
    if (host.startsWith("[") && host.endsWith("]")) return host;
    return `[${host}]`;
  }
  return host;
}

async function readJSONBody(request: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error("Request body too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return null;
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    return null;
  }

  return JSON.parse(text);
}

async function startWebReviewSession(options: {
  html: string;
  host: string;
  port: number | null;
  tokenPath: string;
  onRequestFile: (payload: ReviewRequestFilePayload) => Promise<ReviewHostMessage>;
}): Promise<WebReviewSession> {
  const tokenPath = options.tokenPath;
  const htmlPath = `${tokenPath}/`;
  const eventsPath = `${tokenPath}/events`;
  const messagePath = `${tokenPath}/message`;

  const pendingMessages: ReviewHostMessage[] = [];
  let sseResponse: ServerResponse | null = null;
  let closed = false;

  let resolveTerminal: (value: ReviewSubmitPayload | ReviewCancelPayload | null) => void = () => {};
  let terminalSettled = false;
  const waitForTerminalMessage = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve) => {
    resolveTerminal = resolve;
  });

  const settleTerminal = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
    if (terminalSettled) return;
    terminalSettled = true;
    resolveTerminal(value);
  };

  const sendHostMessage = (message: ReviewHostMessage): void => {
    if (closed) return;
    if (sseResponse == null) {
      pendingMessages.push(message);
      return;
    }

    sseResponse.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  const closeSSE = (): void => {
    if (sseResponse == null) return;
    try {
      sseResponse.end();
    } catch {}
    sseResponse = null;
  };

  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const pathname = requestUrl.pathname;
      const method = (request.method ?? "GET").toUpperCase();

      if (method === "GET" && (pathname === tokenPath || pathname === htmlPath)) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(options.html);
        return;
      }

      if (method === "GET" && pathname === eventsPath) {
        closeSSE();
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write("retry: 1000\n\n");
        sseResponse = response;

        while (pendingMessages.length > 0) {
          const next = pendingMessages.shift();
          if (next != null) {
            response.write(`data: ${JSON.stringify(next)}\n\n`);
          }
        }

        request.on("close", () => {
          if (sseResponse === response) {
            sseResponse = null;
          }
        });
        return;
      }

      if (method === "POST" && pathname === messagePath) {
        let payload: unknown;
        try {
          payload = await readJSONBody(request);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: message }));
          return;
        }

        const message = payload as ReviewWindowMessage;
        if (isRequestFilePayload(message)) {
          const hostMessage = await options.onRequestFile(message);
          sendHostMessage(hostMessage);
          response.writeHead(204);
          response.end();
          return;
        }

        if (isSubmitPayload(message) || isCancelPayload(message)) {
          settleTerminal(message);
          response.writeHead(204);
          response.end();
          return;
        }

        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "Invalid message payload." }));
        return;
      }

      if (method === "GET" && pathname === "/favicon.ico") {
        response.writeHead(404);
        response.end();
        return;
      }

      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: message }));
      } catch {}
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, options.host);
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Could not resolve web server address.");
  }

  const socketAddress = address as AddressInfo;
  const displayHost = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
  const url = `http://${formatHostForUrl(displayHost)}:${socketAddress.port}${htmlPath}`;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    closeSSE();
    settleTerminal(null);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    url,
    tokenPath,
    waitForTerminalMessage,
    close,
  };
}

let activeWaitingUIDismiss: (() => void) | null = null;

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWebSessionURL: string | null = null;
  let activeWebSessionTokenPath: string | null = null;
  let activeWebSessionClose: (() => Promise<void>) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  async function closeActiveWebSession(): Promise<void> {
    if (activeWebSessionClose == null) return;
    const close = activeWebSessionClose;
    activeWebSessionClose = null;
    activeWebSessionURL = null;
    activeWebSessionTokenPath = null;
    try {
      await close();
    } catch {}
  }

  async function reviewRepository(ctx: ExtensionCommandContext, commandOptions: DiffReviewCommandOptions): Promise<void> {
    if (activeWindow != null || activeWebSessionClose != null) {
      ctx.ui.notify("A review session is already open.", "warning");
      return;
    }

    const { repoRoot, files } = await getReviewWindowData(pi, ctx.cwd);
    if (files.length === 0) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"]): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, repoRoot, file, scope);
      contentCache.set(cacheKey, pending);
      return pending;
    };

    const buildHostMessageForFileRequest = async (message: ReviewRequestFilePayload): Promise<ReviewHostMessage> => {
      const file = fileMap.get(message.fileId);
      if (file == null) {
        return {
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          message: "Unknown file requested.",
        };
      }

      try {
        const contents = await loadContents(file, message.scope);
        return {
          type: "file-data",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          originalContent: contents.originalContent,
          modifiedContent: contents.modifiedContent,
        };
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        return {
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          message: messageText,
        };
      }
    };

    try {
      if (commandOptions.mode === "web") {
        const token = randomBytes(12).toString("hex");
        const tokenPath = `/diff-review-${token}`;
        const html = buildReviewHtml(
          { repoRoot, files },
          { bridgeScript: buildWebBridgeScript(tokenPath) },
        );

        const webSession = await startWebReviewSession({
          html,
          host: commandOptions.host,
          port: commandOptions.port,
          tokenPath,
          onRequestFile: buildHostMessageForFileRequest,
        });

        activeWebSessionURL = webSession.url;
        activeWebSessionTokenPath = webSession.tokenPath;
        activeWebSessionClose = webSession.close;

        const waitingUI = showWaitingUI(ctx, "Waiting for browser review", [
          `Open this URL: ${webSession.url}`,
          `Secret token path: ${webSession.tokenPath}`,
          "Press Escape to cancel and close the web review server.",
        ]);

        ctx.ui.notify(`Web review ready: ${webSession.url}`, "info");
        ctx.ui.notify(`Token path: ${webSession.tokenPath}`, "info");

        const result = await Promise.race([
          webSession.waitForTerminalMessage.then((message) => ({ type: "web" as const, message })),
          waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
        ]);

        if (result.type === "ui" && result.reason === "escape") {
          await closeActiveWebSession();
          await webSession.waitForTerminalMessage.catch(() => null);
          ctx.ui.notify("Review cancelled.", "info");
          return;
        }

        const message = result.type === "web" ? result.message : await webSession.waitForTerminalMessage;

        waitingUI.dismiss();
        await waitingUI.promise;
        await closeActiveWebSession();

        if (message == null || message.type === "cancel") {
          ctx.ui.notify("Review cancelled.", "info");
          return;
        }

        const prompt = composeReviewPrompt(files, message);
        ctx.ui.setEditorText(prompt);
        ctx.ui.notify("Inserted review feedback into the editor.", "info");
        return;
      }

      const html = buildReviewHtml({ repoRoot, files });
      const window = open(html, {
        width: 1680,
        height: 1020,
        title: "pi review",
      });
      activeWindow = window;

      const waitingUI = showWaitingUI(ctx, "Waiting for review", [
        "The native review window is open.",
        "Press Escape to cancel and close the review window.",
      ]);

      const sendWindowMessage = (message: ReviewHostMessage): void => {
        if (activeWindow !== window) return;
        const payload = escapeForInlineScript(JSON.stringify(message));
        window.send(`window.__reviewReceive(${payload});`);
      };

      ctx.ui.notify("Opened native review window.", "info");

      const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;
          if (isRequestFilePayload(message)) {
            void (async () => {
              const hostMessage = await buildHostMessageForFileRequest(message);
              sendWindowMessage(hostMessage);
            })();
            return;
          }

          if (isSubmitPayload(message) || isCancelPayload(message)) {
            settle(message);
          }
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      await closeActiveWebSession();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open diff review UI (native by default, or web mode with --web)",
    handler: async (args, ctx) => {
      let parsed: ParsedDiffReviewCommand;
      try {
        parsed = parseDiffReviewCommand(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      if (parsed.showHelp) {
        diffReviewUsageLines().forEach((line) => {
          ctx.ui.notify(line, "info");
        });
        return;
      }

      await reviewRepository(ctx, parsed.options);
    },
  });

  pi.registerCommand("diff-review-token", {
    description: "Show the active web review URL and secret token path",
    handler: async (_args, ctx) => {
      if (activeWebSessionURL == null || activeWebSessionTokenPath == null) {
        ctx.ui.notify("No active web review session.", "info");
        return;
      }

      ctx.ui.notify(`Web review URL: ${activeWebSessionURL}`, "info");
      ctx.ui.notify(`Secret token path: ${activeWebSessionTokenPath}`, "info");
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
    await closeActiveWebSession();
  });
}
