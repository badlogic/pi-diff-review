export interface ReviewHostPublishLifecycle<T> {
  readonly active: boolean;
  readonly terminalRequested: boolean;
  readonly terminal: Promise<T | null>;
  readonly callbacks: ReviewHostPublishLifecycleCallbacks<T>;
  startPublish(task: () => Promise<void>): Promise<void> | null;
  markDirty(): void;
  persist(): Promise<boolean>;
  onTerminalEscape(): Promise<T | null>;
  onSessionShutdown(): Promise<T | null>;
}

export interface ReviewHostPublishLifecycleCallbacks<T> {
  onRendererClosed(): void;
  onControllerError(error: Error): void;
  onAuthenticatedTerminal(message: T): void;
}

export interface ReviewHostPublishLifecycleOptions {
  closeWindow: () => void;
  persist: () => Promise<boolean>;
  onSettling: () => void;
}

export function createReviewHostPublishLifecycle<T>(
  options: ReviewHostPublishLifecycleOptions,
): ReviewHostPublishLifecycle<T> {
  let active = true;
  let terminalRequested = false;
  let closeRequested = false;
  let activePublish: Promise<void> | null = null;
  let persistPromise: Promise<boolean> | null = null;
  let resolveTerminal!: (value: T | null) => void;
  let rejectTerminal!: (error: Error) => void;
  const terminal = new Promise<T | null>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });

  const persist = (): Promise<boolean> => {
    persistPromise ??= Promise.resolve().then(options.persist);
    return persistPromise;
  };

  const requestClose = (): void => {
    if (closeRequested) return;
    closeRequested = true;
    options.closeWindow();
  };

  const settle = (
    value: T | null,
    error: Error | null,
    shouldClose: boolean,
  ): Promise<T | null> => {
    if (terminalRequested) return terminal;
    terminalRequested = true;
    if (shouldClose) requestClose();
    options.onSettling();

    void (async () => {
      try {
        try {
          await activePublish;
        } catch {
          // Publish reports its own result; terminal paths still have to persist queued state.
        }
        await persist();
      } finally {
        active = false;
      }

      if (error != null) {
        rejectTerminal(error);
      } else {
        resolveTerminal(value);
      }
    })().catch((drainError: unknown) => {
      active = false;
      rejectTerminal(error ?? (drainError instanceof Error ? drainError : new Error(String(drainError))));
    });

    return terminal;
  };

  const callbacks: ReviewHostPublishLifecycleCallbacks<T> = {
    onRendererClosed(): void {
      void settle(null, null, false).catch(() => undefined);
    },
    onControllerError(error): void {
      void settle(null, error, false).catch(() => undefined);
    },
    onAuthenticatedTerminal(message): void {
      void settle(message, null, false).catch(() => undefined);
    },
  };

  return {
    get active(): boolean {
      return active;
    },
    get terminalRequested(): boolean {
      return terminalRequested;
    },
    terminal,
    callbacks,
    startPublish(task): Promise<void> | null {
      if (!active || terminalRequested || activePublish != null) return null;
      persistPromise = null;
      const pending = Promise.resolve().then(task);
      const tracked = pending.finally(() => {
        if (activePublish === tracked) activePublish = null;
      });
      activePublish = tracked;
      return tracked;
    },
    markDirty(): void {
      if (active) persistPromise = null;
    },
    persist,
    onTerminalEscape(): Promise<T | null> {
      return settle(null, null, true);
    },
    onSessionShutdown(): Promise<T | null> {
      return settle(null, null, true);
    },
  };
}
