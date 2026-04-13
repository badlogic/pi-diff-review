import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, Text } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { getReviewConfigLocations, loadReviewConfig, saveReviewConfig, type ReviewConfig } from "./config.js";
import { getRepoRoot, getReviewWindowData, loadReviewFileContents, resolveBaseRef } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  ReviewCancelPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowData,
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

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function parseBaseOverride(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatConfigSummary(
  config: ReviewConfig,
  effectiveBaseRef: string,
  locations: { globalConfigPath: string; projectConfigPath: string },
): string {
  return [
    "diff-review config",
    "",
    `configured defaultBaseRef: ${config.defaultBaseRef}`,
    `effective base ref: ${effectiveBaseRef}`,
    `preferredInitialScope: ${config.preferredInitialScope}`,
    `preferredHideUnchanged: ${String(config.preferredHideUnchanged)}`,
    `preferredWrapLines: ${String(config.preferredWrapLines)}`,
    `preferredSidebarCollapsed: ${String(config.preferredSidebarCollapsed)}`,
    `autoFetchBaseRef: ${String(config.autoFetchBaseRef)}`,
    "",
    `project config: ${locations.projectConfigPath}`,
    `global config: ${locations.globalConfigPath}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
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
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
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

  async function buildWindowData(ctx: ExtensionCommandContext, baseOverride?: string): Promise<{ config: ReviewConfig; data: ReviewWindowData }> {
    const repoRoot = await getRepoRoot(pi, ctx.cwd);
    const storedConfig = await loadReviewConfig(repoRoot);
    const configuredBaseRef = baseOverride ?? storedConfig.defaultBaseRef;
    const effectiveBaseRef = await resolveBaseRef(pi, repoRoot, configuredBaseRef, storedConfig.autoFetchBaseRef);
    const config: ReviewConfig = {
      ...storedConfig,
      defaultBaseRef: effectiveBaseRef,
    };
    const { files } = await getReviewWindowData(pi, ctx.cwd, config);

    return {
      config,
      data: {
        repoRoot,
        files,
        defaultBaseRef: effectiveBaseRef,
        preferredInitialScope: config.preferredInitialScope,
        preferredHideUnchanged: config.preferredHideUnchanged,
        preferredWrapLines: config.preferredWrapLines,
        preferredSidebarCollapsed: config.preferredSidebarCollapsed,
      },
    };
  }

  async function reviewRepository(ctx: ExtensionCommandContext, baseOverride?: string): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    const { config, data } = await buildWindowData(ctx, baseOverride);
    const { repoRoot, files } = data;
    if (files.length === 0) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const html = buildReviewHtml(data);
    const window = open(html, {
      width: 1680,
      height: 1020,
      title: `pi review • ${config.defaultBaseRef}`,
    });
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx);
    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
    };

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"]): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, repoRoot, file, scope, config);
      contentCache.set(cacheKey, pending);
      return pending;
    };

    ctx.ui.notify(`Opened native review window (${config.defaultBaseRef}).`, "info");

    try {
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

        const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
          const file = fileMap.get(message.fileId);
          if (file == null) {
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              message: "Unknown file requested.",
            });
            return;
          }

          try {
            const contents = await loadContents(file, message.scope);
            sendWindowMessage({
              type: "file-data",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              originalContent: contents.originalContent,
              modifiedContent: contents.modifiedContent,
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              message: messageText,
            });
          }
        };

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;
          if (isRequestFilePayload(message)) {
            void handleRequestFile(message);
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

      const prompt = composeReviewPrompt(files, message, config.defaultBaseRef);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native review window. Optional args: pass a base ref for one-off branch comparison.",
    handler: async (args, ctx) => {
      await reviewRepository(ctx, parseBaseOverride(args));
    },
  });

  pi.registerMessageRenderer("diff-review-config", (message) => new Text(String(message.content), 0, 0));

  pi.registerCommand("diff-review-set-base", {
    description: "Persist the default base ref for diff review. Usage: /diff-review-set-base [--global] <git-ref|default>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        ctx.ui.notify("Usage: /diff-review-set-base [--global] <git-ref|default>", "warning");
        return;
      }

      const globalPrefix = "--global ";
      const scope = trimmed.startsWith(globalPrefix) ? "global" : "project";
      const baseRef = (scope === "global" ? trimmed.slice(globalPrefix.length) : trimmed).trim();
      if (baseRef.length === 0) {
        ctx.ui.notify("Usage: /diff-review-set-base [--global] <git-ref|default>", "warning");
        return;
      }

      const repoRoot = await getRepoRoot(pi, ctx.cwd);
      const currentConfig = await loadReviewConfig(repoRoot);
      const configPath = await saveReviewConfig(repoRoot, { defaultBaseRef: baseRef }, scope);
      const effectiveBaseRef = await resolveBaseRef(pi, repoRoot, baseRef, currentConfig.autoFetchBaseRef);
      ctx.ui.notify(`Saved default base ref ${baseRef} (${effectiveBaseRef}) to ${configPath}`, "info");
    },
  });

  pi.registerCommand("diff-review-config", {
    description: "Show the effective diff-review config and config file paths",
    handler: async (_args, ctx) => {
      const repoRoot = await getRepoRoot(pi, ctx.cwd);
      const config = await loadReviewConfig(repoRoot);
      const effectiveBaseRef = await resolveBaseRef(pi, repoRoot, config.defaultBaseRef, config.autoFetchBaseRef);
      const locations = getReviewConfigLocations(repoRoot);
      pi.sendMessage({
        customType: "diff-review-config",
        content: formatConfigSummary(config, effectiveBaseRef, locations),
        display: true,
      });
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
