import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { createAiReviewFailedProgress, runAiReview } from "./ai-review.js";
import { loadAiReviewRuntimeConfig } from "./ai-review-config.js";
import { createFallbackAnalysis } from "./analysis.js";
import { parseDiffReviewArgs } from "./command.js";
import { createReviewFilePatchLoader } from "./file-patch.js";
import { loadReviewFileContents } from "./git.js";
import { fetchGitHubReviewContext } from "./github-review-context.js";
import {
  buildGitHubReviewPublishPlan,
  publishGitHubReview,
  reconcileGitHubReview,
  revalidateGitHubReviewPublishPlan,
  type BuildGitHubReviewPublishPlanOptions,
  type GitHubReviewPublishPlan,
} from "./github-publish.js";
import { composeReviewPrompt } from "./prompt.js";
import { compileProvisionalReviewMap } from "./provisional-review-map.js";
import { extractReviewChangeUnits } from "./review-change-units.js";
import { buildReviewMapPlannerInput } from "./review-map-planner.js";
import { runSemanticReviewMap } from "./review-map-runner.js";
import { runReviewMapScouts } from "./review-map-scout.js";
import { completeStructuredText } from "./structured-model-completion.js";
import { type RendererProtocolContext } from "./renderer-protocol.js";
import {
  createReviewHostPublishLifecycle,
  type ReviewHostPublishLifecycle,
} from "./review-host-publish-lifecycle.js";
import { runReviewSessionStartupPersistence } from "./review-session-startup.js";
import { createReviewWindowController, type ReviewWindowController } from "./review-window.js";
import { buildGitHubPrReviewDataset } from "./sources/github-pr.js";
import { buildLocalReviewDataset } from "./sources/local.js";
import {
  buildReviewDiffFingerprint,
  buildReviewSessionRecord,
  createGitHubPublishSessionController,
  getReviewSessionDescriptor,
  loadReviewSession,
  mergeAuthoritativePublishedComments,
  publishedCommentsFromSnapshot,
  publishedCommentsFromConfirmedIntent,
  resolveSubmittedCommentsFromSnapshot,
  resolveReviewSession,
  resetReviewSession,
  ReviewSessionConflictError,
  reviewSessionRecoveryPath,
  reviewSessionRecordState,
  saveReviewSession,
  type GitHubPublishIntentTransition,
  type GitHubPublishSessionController,
  type ReviewSessionRecord,
  type ReviewSessionRecordState,
} from "./session-store.js";
import type {
  ReviewCancelPayload,
  ReviewCheckpointSessionPayload,
  DiffReviewComment,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewMap,
  ReviewAnalysis,
  GitHubReviewPublishIntent,
  ReviewPublishPayload,
  ReviewPublishGitHubReviewSuccessMessage,
  ReviewRunAiReviewPayload,
  ReviewRefreshGitHubContextPayload,
  ReviewOpenExternalUrlPayload,
  GitHubReviewContextSnapshot,
  ReviewRequestFilePayload,
  ReviewRendererSessionSnapshot,
  ReviewSaveSessionPayload,
  ReviewSessionSnapshot,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { getReviewShellPath } from "./ui.js";

const REVIEW_MAP_SCOUT_PROMPT = `You inspect bounded diff change units for a code-review map. Return strict JSON only with {"facts":[...]}. Each fact must contain unitIds, intent, changedContracts, callersAndDependencies, removedBehavior, invariants, testEvidence, evidenceGaps, candidateRelationships, confidence, and unresolvedQuestions. Return facts, not chapters, findings, or verdicts. Reference only supplied unit IDs.`;
const REVIEW_MAP_PLANNER_PROMPT = `You design a human review journey for a pull request. Return strict JSON only with story and chapters. Organize by end-to-end behavior, not directories or file types. Pair tests with the behavior they verify. Every chapter needs id, title, objective, whyItMatters, priority, priorityReason, dependsOn, reviewQuestions, changeFlow, visits, testEvidence, and exitCriteria. Every visit needs id, fileId, changeUnitIds, role, reason, and focus. Assign each supplied unit exactly once and reference no invented IDs.`;
const REVIEW_MAP_CRITIC_PROMPT = `You are an adversarial critic of a proposed human code-review journey. Return strict JSON only: {"action":"accept"|"repair","diagnostics":[...],"instructions":"..."}. Require behavioral chapters, coherent dependency order, implementation paired with evidence or an explicit gap, no generic Tests or Miscellaneous buckets, and manageable chapter scope. Use repair when the proposal is shallow or unsupported.`;

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

function isPublishPayload(value: ReviewWindowMessage): value is ReviewPublishPayload {
  return value.type === "publish-github-review";
}

function isRunAiReviewPayload(value: ReviewWindowMessage): value is ReviewRunAiReviewPayload {
  return value.type === "run-ai-review";
}

function isRefreshGitHubContextPayload(value: ReviewWindowMessage): value is ReviewRefreshGitHubContextPayload {
  return value.type === "refresh-github-context";
}

function isOpenExternalUrlPayload(value: ReviewWindowMessage): value is ReviewOpenExternalUrlPayload {
  return value.type === "open-external-url";
}

function isSaveSessionPayload(value: ReviewWindowMessage): value is ReviewSaveSessionPayload {
  return value.type === "save-session";
}

function isCheckpointSessionPayload(value: ReviewWindowMessage): value is ReviewCheckpointSessionPayload {
  return value.type === "checkpoint-session";
}

export function mergeRendererSessionCheckpoint(
  current: ReviewSessionSnapshot | null | undefined,
  checkpoint: ReviewRendererSessionSnapshot,
): ReviewSessionSnapshot {
  const {
    map: _map,
    analysis: _analysis,
    githubPublishIntent: _githubPublishIntent,
    githubContext: _githubContext,
    ...rendererOwned
  } = checkpoint as ReviewSessionSnapshot;
  return { ...(current ?? {}), ...rendererOwned };
}

type WaitingEditorResult = "escape" | "window-settled";

export { createReviewHostPublishLifecycle } from "./review-host-publish-lifecycle.js";

const ABANDON_AMBIGUOUS_PUBLISH_FLAG = "--abandon-ambiguous-publish";

export function extractReviewHostOptions(args: string[]): {
  commandArgs: string[];
  abandonAmbiguousPublish: boolean;
} {
  return {
    commandArgs: args.filter((arg) => arg !== ABANDON_AMBIGUOUS_PUBLISH_FLAG),
    abandonAmbiguousPublish: args.includes(ABANDON_AMBIGUOUS_PUBLISH_FLAG),
  };
}

export async function reconcileGitHubPublishForReviewOpen(options: {
  controller: Pick<GitHubPublishSessionController, "reconcileOutstanding" | "abandonOutstanding">;
  reconcileRemote: Parameters<GitHubPublishSessionController["reconcileOutstanding"]>[0];
  abandonAmbiguousPublish: boolean;
  warn: (message: string) => void;
}): ReturnType<GitHubPublishSessionController["reconcileOutstanding"]> {
  try {
    if (options.abandonAmbiguousPublish) {
      const abandoned = await options.controller.abandonOutstanding();
      if (abandoned.warning != null) options.warn(abandoned.warning);
    }
    const reconciliation = await options.controller.reconcileOutstanding(options.reconcileRemote);
    if (reconciliation.status === "blocked" && reconciliation.warning != null) {
      options.warn(reconciliation.warning);
    }
    return reconciliation;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const warning = `GitHub review reconciliation could not complete: ${detail}. Review can continue, but publishing is blocked until reconciliation succeeds.`;
    options.warn(warning);
    return { status: "blocked", warning };
  }
}

export async function prepareGitHubPublishPost(options: {
  loadPersistedSession: () => Promise<Pick<ReviewSessionRecord, "snapshot" | "revision" | "recordHash"> | null>;
  expectedPlan: GitHubReviewPublishPlan;
  originalOptions: BuildGitHubReviewPublishPlanOptions;
  acceptPersistedRecord: (
    record: Pick<ReviewSessionRecord, "snapshot" | "revision" | "recordHash">,
  ) => void;
  markPostStarting: () => Promise<void>;
}): Promise<void> {
  const persisted = await options.loadPersistedSession();
  if (persisted == null) {
    throw new Error("The durable review session disappeared before GitHub publish. Refresh the review before retrying.");
  }
  const revalidated = revalidateGitHubReviewPublishPlan({
    expectedPlan: options.expectedPlan,
    originalOptions: options.originalOptions,
    persistedSnapshot: persisted.snapshot,
  });
  if (revalidated.payload == null) {
    throw new Error(revalidated.errors.map((error) => error.message).join(" "));
  }
  options.acceptPersistedRecord(persisted);
  await options.markPostStarting();
}

export function buildGitHubPublishSuccessResult(options: {
  requestId: string;
  message: string;
  confirmedIntent: GitHubReviewPublishIntent | null;
}): ReviewPublishGitHubReviewSuccessMessage {
  const intent = options.confirmedIntent;
  if (intent?.status !== "confirmed" || intent.receipt == null) {
    throw new Error("A GitHub publish success result requires a durably confirmed publish intent.");
  }
  const publishedComments = publishedCommentsFromConfirmedIntent(intent);
  if (publishedComments.length !== intent.representedCommentIds.length
    || publishedComments.some((comment, index) => comment.id !== intent.representedCommentIds[index])) {
    throw new Error("The confirmed GitHub publish intent does not represent its authoritative comments exactly once.");
  }
  const submittedAt = intent.receipt.submittedAt ?? publishedComments[0]?.publishedAt ?? intent.updatedAt;
  return {
    type: "publish-github-review-result",
    requestId: options.requestId,
    ok: true,
    message: options.message,
    publishedCommentIds: [...intent.representedCommentIds],
    publishedComments,
    submittedAt,
    ...(intent.receipt.reviewId == null ? {} : { reviewId: intent.receipt.reviewId }),
    ...(intent.receipt.reviewUrl == null ? {} : { reviewUrl: intent.receipt.reviewUrl }),
    warnings: [...intent.receipt.warnings],
  };
}

function reviewWindowTitle(dataset: { repoRoot: string; source: { github?: { owner: string; repo: string; number: number } } }): string {
  const github = dataset.source.github;
  if (github != null) {
    return `Review PR #${github.number} · ${github.owner}/${github.repo}`;
  }
  return `Diff review · ${basename(dataset.repoRoot) || "repository"}`;
}

function rendererProtocolContext(files: ReviewFile[], commits: { sha: string }[], analysis: ReviewAnalysis, map?: ReviewMap): Omit<RendererProtocolContext, "sessionId" | "capability"> {
  return {
    files: new Map(files.map((file) => {
      const scopes = new Set<"git-diff" | "last-commit" | "commit" | "all-files">();
      if (file.inGitDiff) scopes.add("git-diff");
      if (file.inLastCommit) scopes.add("last-commit");
      if (file.hasWorkingTreeFile) scopes.add("all-files");
      const commitShas = new Set(Object.keys(file.commitComparisons));
      if (commitShas.size > 0) scopes.add("commit");
      return [file.id, { scopes, commitShas }];
    })),
    commitShas: new Set(commits.map((commit) => commit.sha)),
    findingIds: new Set(analysis.findings.map((finding) => finding.id)),
    chapterIds: new Set((map?.chapters ?? analysis.chapters).map((chapter) => chapter.id)),
    visitIds: new Set(map?.chapters.flatMap((chapter) => chapter.visits.map((visit) => visit.id)) ?? []),
  };
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;
  let activeReviewCompletion: Promise<void> | null = null;
  let activeReviewLifecycle: ReviewHostPublishLifecycle<ReviewSubmitPayload | ReviewCancelPayload> | null = null;

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

  async function reviewRepository(args: string[], ctx: ExtensionCommandContext): Promise<void> {
    if (activeWindow != null || activeReviewLifecycle?.active === true || activeReviewCompletion != null) {
      ctx.ui.notify("A review is already open or finishing publication.", "warning");
      return;
    }

    const hostOptions = extractReviewHostOptions(args);
    const command = parseDiffReviewArgs(hostOptions.commandArgs);
    const dataset = command.mode === "github-pr"
      ? await buildGitHubPrReviewDataset(pi, ctx, command.url)
      : await buildLocalReviewDataset(pi, ctx);
    const { workingRoot, files } = dataset;
    if (files.length === 0) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const revisionDiff = dataset.source.kind === "github-pr" && dataset.source.baseRevision != null && dataset.source.headRevision != null
      ? { baseRevision: dataset.source.baseRevision, headRevision: dataset.source.headRevision }
      : undefined;

    const rawLoadFilePatch = createReviewFilePatchLoader(pi, {
      repoRoot: dataset.repoRoot,
      workingRoot,
      revisionDiff,
    });
    const patchCache = new Map<string, Promise<string>>();
    const loadFilePatch = (file: ReviewFile): Promise<string> => {
      const cached = patchCache.get(file.id);
      if (cached != null) return cached;
      const pending = rawLoadFilePatch(file);
      patchCache.set(file.id, pending);
      return pending;
    };

    ctx.ui.notify("Preparing review session.", "info");
    const sessionDescriptor = await getReviewSessionDescriptor(pi, dataset);
    if (command.resetReview) {
      await resetReviewSession(sessionDescriptor.storagePath);
      ctx.ui.notify("Reset saved review metadata for this source.", "info");
    }
    const fingerprint = await buildReviewDiffFingerprint(pi, dataset, loadFilePatch);
    let storedSession: Awaited<ReturnType<typeof loadReviewSession>>;
    try {
      storedSession = await loadReviewSession(sessionDescriptor.storagePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review session metadata could not be trusted: ${message}`, "error");
      throw error;
    }
    const sessionResolution = resolveReviewSession({
      stored: storedSession,
      sourceKey: sessionDescriptor.sourceKey,
      currentFingerprint: fingerprint,
      dataset,
    });
    const recoveryPath = sessionResolution.status === "stale" && storedSession != null
      ? reviewSessionRecoveryPath(sessionDescriptor.storagePath, storedSession)
      : null;

    const focusedFiles = dataset.analysisFileIds
      .map((fileId) => dataset.files.find((file) => file.id === fileId))
      .filter((file): file is ReviewFile => file != null);
    const units = (await Promise.all(focusedFiles.map(async (file) => extractReviewChangeUnits({
      sourceFingerprint: fingerprint.hash,
      file,
      patch: await loadFilePatch(file),
      commitIds: Object.keys(file.commitComparisons),
    })))).flat();
    const restoredMap = sessionResolution.snapshot?.map;
    let reviewMap = restoredMap?.version === 2
      && restoredMap.sourceFingerprint === fingerprint.hash
      && (restoredMap.strategyVersion === "provisional-map-v1" || restoredMap.strategyVersion === "semantic-map-v1")
      ? restoredMap
      : compileProvisionalReviewMap({
          sourceFingerprint: fingerprint.hash,
          units,
          commits: dataset.commits,
        });

    let analysis: ReviewAnalysis;
    if (sessionResolution.analysis == null) {
      analysis = createFallbackAnalysis(dataset, "Diff is ready. AI findings will stream in after the review window opens.");
    } else {
      ctx.ui.notify("Restored cached review state.", "info");
      analysis = sessionResolution.analysis;
    }
    const aiReviewConfig = await loadAiReviewRuntimeConfig(ctx, dataset);

    let sessionSnapshot: ReviewSessionSnapshot | null = {
      ...(sessionResolution.snapshot ?? {}),
      map: reviewMap,
    };
    let persistedSessionState: ReviewSessionRecordState | null = reviewSessionRecordState(storedSession);
    let publishSessionController: GitHubPublishSessionController | null = null;
    let publishWarning: string | null = null;
    const authoritativePublishedComments = new Map<string, DiffReviewComment>();
    const refreshAuthoritativePublishedComments = (): void => {
      for (const comment of publishedCommentsFromSnapshot(sessionSnapshot)) {
        authoritativePublishedComments.set(comment.id, { ...comment, status: "published", published: true });
      }
    };
    refreshAuthoritativePublishedComments();
    const mergeSessionSnapshot = (snapshot: ReviewSessionSnapshot): ReviewSessionSnapshot => {
      const withPublished = mergeAuthoritativePublishedComments(snapshot, authoritativePublishedComments.values());
      return publishSessionController?.mergeSnapshot(withPublished) ?? withPublished;
    };
    let saveChain: Promise<void> = Promise.resolve();
    let saveRevision = 0;
    let pendingRendererCheckpoint: ReviewRendererSessionSnapshot | null = null;
    let sendSaveResult: ((requestId: string, ok: boolean, message?: string, retryable?: boolean) => void) | null = null;
    const queueSessionSave = (
      snapshot: ReviewSessionSnapshot,
      requestId?: string,
      publishIntentTransition?: GitHubPublishIntentTransition,
    ): void => {
      activeReviewLifecycle?.markDirty();
      const checkpoint = pendingRendererCheckpoint;
      pendingRendererCheckpoint = null;
      const snapshotToSave = checkpoint == null
        ? snapshot
        : mergeRendererSessionCheckpoint(snapshot, checkpoint);
      const revision = ++saveRevision;
      sessionSnapshot = mergeSessionSnapshot(snapshotToSave);
      saveChain = saveChain
        .catch(() => undefined)
        .then(async () => {
          try {
            const mergedSnapshot = mergeSessionSnapshot(snapshotToSave);
            const analysisToSave = mergedSnapshot.analysis?.approvalPacket
              ? {
                  ...analysis,
                  approvalPacket: mergedSnapshot.analysis.approvalPacket,
                }
              : analysis;
            const persisted = await saveReviewSession(sessionDescriptor.storagePath, buildReviewSessionRecord({
              sourceKey: sessionDescriptor.sourceKey,
              fingerprint,
              analysis: analysisToSave,
              snapshot: mergedSnapshot,
            }), {
              expectedRecordState: publishIntentTransition?.expectedRecordState ?? persistedSessionState,
              publishIntentTransition,
            });
            persistedSessionState = reviewSessionRecordState(persisted);
            if (revision === saveRevision) {
              sessionSnapshot = persisted.snapshot;
              refreshAuthoritativePublishedComments();
            }
            if (requestId != null) {
              sendSaveResult?.(requestId, true);
            }
          } catch (error) {
            if (requestId != null) {
              const message = error instanceof Error ? error.message : String(error);
              sendSaveResult?.(requestId, false, message, !(error instanceof ReviewSessionConflictError));
            }
            throw error;
          }
        });
    };
    const checkpointRendererSession = (snapshot: ReviewRendererSessionSnapshot): void => {
      pendingRendererCheckpoint = snapshot;
      sessionSnapshot = mergeSessionSnapshot(mergeRendererSessionCheckpoint(sessionSnapshot, snapshot));
      activeReviewLifecycle?.markDirty();
    };
    const flushSessionSave = async (): Promise<boolean> => {
      try {
        if (pendingRendererCheckpoint != null) {
          queueSessionSave(sessionSnapshot ?? {});
        }
        await saveChain;
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save review session: ${message}`, "warning");
        return false;
      }
    };
    const snapshotFromSubmit = (message: ReviewSubmitPayload): ReviewSessionSnapshot => mergeSessionSnapshot({
      ...(sessionSnapshot ?? {}),
      map: reviewMap,
      analysis,
      overallComment: message.overallComment,
      comments: message.comments,
      acceptedFindingComments: Object.fromEntries(message.acceptedFindings.map((finding) => [finding.findingId, finding.body])),
      findingStatuses: Object.fromEntries(message.findingStatuses.map((finding) => [finding.findingId, finding.status])),
    });

    const reconcilePublishIntent = async (intent: GitHubReviewPublishIntent) => {
      const github = dataset.source.github;
      if (github == null) {
        throw new Error("A saved GitHub publish intent cannot be reconciled for a non-GitHub review source.");
      }
      return await reconcileGitHubReview(pi, dataset.workingRoot, github, {
        correlationId: intent.correlationId,
        reviewedHeadSha: intent.source.reviewedHeadSha,
      });
    };

    await runReviewSessionStartupPersistence({
      confirmedIntent: sessionResolution.confirmedPublishIntentToRetire,
      snapshot: sessionSnapshot,
      recordState: persistedSessionState,
      persistConfirmedRetirement: async (snapshot, transition) => await saveReviewSession(
        sessionDescriptor.storagePath,
        buildReviewSessionRecord({
          sourceKey: sessionDescriptor.sourceKey,
          fingerprint,
          analysis,
          snapshot,
        }),
        {
          expectedRecordState: transition.expectedRecordState,
          publishIntentTransition: transition,
        },
      ),
      initializeRuntime: async (state) => {
        sessionSnapshot = state.snapshot;
        persistedSessionState = state.recordState;
        if (sessionResolution.confirmedPublishIntentToRetire != null) {
          refreshAuthoritativePublishedComments();
          ctx.ui.notify("Preserved published comments for unchanged patches and retired the prior confirmed publish receipt.", "info");
        }

        const github = dataset.source.github;
        const reviewedBaseSha = dataset.source.baseRevision;
        const reviewedHeadSha = dataset.source.headRevision;
        if (github == null || reviewedBaseSha == null || reviewedHeadSha == null) return;

        const controller = createGitHubPublishSessionController({
          source: {
            sourceKey: sessionDescriptor.sourceKey,
            owner: github.owner,
            repo: github.repo,
            pullNumber: github.number,
            reviewedBaseSha,
            reviewedHeadSha,
          },
          initialIntent: sessionSnapshot.githubPublishIntent ?? null,
          getSnapshot: () => sessionSnapshot ?? {},
          getRecordState: () => persistedSessionState,
          persistSnapshot: async (snapshot, transition) => {
            let selectedTransition = transition;
            if (transition.expected?.status === "ambiguous") {
              if (!await flushSessionSave()) return false;
              selectedTransition = {
                ...transition,
                expectedRecordState: persistedSessionState,
              };
            }
            queueSessionSave(snapshot, undefined, selectedTransition);
            return await flushSessionSave();
          },
        });
        publishSessionController = controller;
        const reconciliation = await reconcileGitHubPublishForReviewOpen({
          controller,
          reconcileRemote: reconcilePublishIntent,
          abandonAmbiguousPublish: hostOptions.abandonAmbiguousPublish,
          warn: (message) => ctx.ui.notify(message, "warning"),
        });
        publishWarning = reconciliation.status === "blocked"
          ? reconciliation.warning ?? "GitHub publishing is blocked until the prior review can be reconciled."
          : null;
        if (reconciliation.status === "confirmed") {
          refreshAuthoritativePublishedComments();
          ctx.ui.notify("Reconciled a previously ambiguous GitHub review submission.", "info");
        }
      },
      persistInitialSnapshot: async () => {
        queueSessionSave({
          ...(sessionSnapshot ?? {}),
          map: reviewMap,
          analysis,
        });
        return await flushSessionSave();
      },
    });
    if (recoveryPath != null) {
      ctx.ui.notify(`Previous local review state was preserved at ${recoveryPath}.`, "warning");
    }

    const reviewData = {
      ...dataset,
      map: reviewMap,
      analysis,
      aiReviewConfig: aiReviewConfig.public,
      session: {
        status: sessionResolution.status,
        message: sessionResolution.message,
        storagePath: sessionDescriptor.storagePath,
        updatedAt: sessionResolution.updatedAt,
        snapshot: sessionSnapshot,
        ...(publishWarning == null ? {} : { publishWarning }),
        ...(recoveryPath == null ? {} : { recoveryPath }),
      },
    };
    const title = reviewWindowTitle(dataset);
    const window = open("", {
      width: 1680,
      height: 1020,
      title,
      hidden: true,
    });
    activeWindow = window;
    let finishActiveReview!: () => void;
    const reviewCompletion = new Promise<void>((resolve) => {
      finishActiveReview = resolve;
    });
    activeReviewCompletion = reviewCompletion;

    const waitingUI = showWaitingUI(ctx);
    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();
    let windowController: ReviewWindowController | null = null;

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      windowController?.sendHostMessage(message);
    };
    sendSaveResult = (requestId, ok, message, retryable): void => {
      sendWindowMessage({
        type: "save-session-result",
        requestId,
        ok,
        message,
        savedAt: ok ? new Date().toISOString() : undefined,
        ...(ok || retryable === undefined ? {} : { retryable }),
      });
    };

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"], commitSha?: string): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${commitSha ?? ""}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, workingRoot, file, scope, commitSha, {
        gitDiffMode: "working-tree",
        revisionDiff,
      });
      contentCache.set(cacheKey, pending);
      return pending;
    };

    ctx.ui.notify("Opened native review window.", "info");

    let reviewLifecycle: ReviewHostPublishLifecycle<ReviewSubmitPayload | ReviewCancelPayload> | null = null;
    try {
      let aiReviewInFlight = false;
      let githubContextInFlight: Promise<GitHubReviewContextSnapshot> | null = null;
      const cleanup = (): void => {
        windowController?.dispose();
        if (activeWindow === window) {
          activeWindow = null;
        }
      };
      const lifecycle = createReviewHostPublishLifecycle<ReviewSubmitPayload | ReviewCancelPayload>({
        closeWindow: closeActiveWindow,
        persist: flushSessionSave,
        onSettling: cleanup,
      });
      reviewLifecycle = lifecycle;
      activeReviewLifecycle = lifecycle;
      const terminalMessagePromise = lifecycle.terminal;
      const canUpdateReviewWindow = (): boolean => !lifecycle.terminalRequested && activeWindow === window;

      const handlePublishGitHubReview = (message: ReviewPublishPayload): void => {
        const pending = lifecycle.startPublish(async () => {
          const github = dataset.source.github;
          const controller = publishSessionController;
          if (github == null || controller == null) {
            ctx.ui.notify("This review source cannot submit GitHub reviews.", "error");
            sendWindowMessage({
              type: "publish-github-review-result",
              requestId: message.requestId,
              ok: false,
              message: "This review source cannot submit GitHub reviews.",
            });
            return;
          }

          const reportSuccess = (
            receipt: Awaited<ReturnType<typeof publishGitHubReview>>,
            reconciled: boolean,
          ): void => {
            const receiptDetails = [
              receipt.reviewId != null ? `Review #${receipt.reviewId}.` : undefined,
              receipt.reviewUrl,
              receipt.submittedAt != null ? `Submitted at ${receipt.submittedAt}.` : undefined,
              receipt.warnings.length > 0 ? `Warnings: ${receipt.warnings.join(" ")}` : undefined,
            ].filter((detail): detail is string => detail != null && detail.length > 0);
            const messageText = [
              reconciled ? "Reconciled the previously ambiguous GitHub review." : "Submitted GitHub review.",
              ...receiptDetails,
            ].join(" ");
            ctx.ui.notify(messageText, receipt.warnings.length > 0 ? "warning" : "info");
            sendWindowMessage(buildGitHubPublishSuccessResult({
              requestId: message.requestId,
              message: messageText,
              confirmedIntent: controller.intent,
            }));
          };

          try {
            if (!await flushSessionSave()) {
              throw new Error("Could not durably save the latest review session before GitHub publish.");
            }
            const outstanding = await controller.reconcileOutstanding(reconcilePublishIntent);
            if (outstanding.status === "confirmed" && outstanding.receipt != null) {
              refreshAuthoritativePublishedComments();
              reportSuccess(
                outstanding.receipt,
                true,
              );
              return;
            }
            if (outstanding.status === "blocked") {
              const messageText = outstanding.warning
                ?? "The prior GitHub review submission remains ambiguous, so publishing is blocked.";
              ctx.ui.notify(messageText, "warning");
              sendWindowMessage({
                type: "publish-github-review-result",
                requestId: message.requestId,
                ok: false,
                message: messageText,
              });
              return;
            }

            const submittedSnapshot = snapshotFromSubmit(message.submit);
            const reviewedHeadSha = dataset.source.headRevision;
            const filePathById = new Map(files.map((file) => [file.id, file.gitDiff?.newPath ?? file.gitDiff?.oldPath ?? file.path]));
            const commentableLinesByFileId = new Map(files.map((file) => [
              file.id,
              {
                original: file.gitDiff?.commentableOriginalLines ?? [],
                modified: file.gitDiff?.commentableModifiedLines ?? [],
              },
            ]));
            const submit = {
              ...message.submit,
              comments: resolveSubmittedCommentsFromSnapshot(message.submit.comments, submittedSnapshot),
            };
            const correlationId = randomUUID();
            const planOptions: BuildGitHubReviewPublishPlanOptions = {
              event: message.event,
              body: message.body,
              submit,
              filePathById,
              commentableLinesByFileId,
              reviewedHeadSha: reviewedHeadSha ?? "",
              correlationId,
            };
            const plan = buildGitHubReviewPublishPlan(planOptions);
            if (plan.payload == null) {
              const messageText = plan.errors.map((error) => error.message).join(" ");
              ctx.ui.notify(`GitHub review submission was not sent: ${messageText}`, "warning");
              sendWindowMessage({
                type: "publish-github-review-result",
                requestId: message.requestId,
                ok: false,
                message: messageText,
              });
              return;
            }

            const receipt = await controller.runPublish({
              correlationId,
              snapshot: submittedSnapshot,
              representedCommentIds: plan.representedCommentIds,
              submittedComments: submit.comments,
            }, async (beforePost) => await publishGitHubReview(
              pi,
              dataset.workingRoot,
              github,
              plan.payload!,
              {
                correlationId,
                reviewedBaseSha: dataset.source.baseRevision ?? "",
                beforePost: async () => {
                  if (!await flushSessionSave()) {
                    throw new Error("Could not durably save the latest review session before GitHub POST.");
                  }
                  await prepareGitHubPublishPost({
                    loadPersistedSession: async () => await loadReviewSession(sessionDescriptor.storagePath),
                    expectedPlan: plan,
                    originalOptions: planOptions,
                    acceptPersistedRecord: (persisted) => {
                      persistedSessionState = {
                        revision: persisted.revision,
                        recordHash: persisted.recordHash,
                      };
                      sessionSnapshot = mergeSessionSnapshot(persisted.snapshot);
                      refreshAuthoritativePublishedComments();
                    },
                    markPostStarting: beforePost,
                  });
                },
              },
            ));
            refreshAuthoritativePublishedComments();
            reportSuccess(receipt, false);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`GitHub review submission failed: ${messageText}`, "error");
            sendWindowMessage({
              type: "publish-github-review-result",
              requestId: message.requestId,
              ok: false,
              message: messageText,
            });
          }
        });
        if (pending != null) {
          void pending.catch((error) => {
            const messageText = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`GitHub review submission failed: ${messageText}`, "error");
          });
          return;
        }

        ctx.ui.notify("A GitHub review submission is already in progress.", "warning");
        sendWindowMessage({
          type: "publish-github-review-result",
          requestId: message.requestId,
          ok: false,
          message: "A GitHub review submission is already in progress.",
        });
      };

      const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
        const file = fileMap.get(message.fileId);
        if (file == null) {
          sendWindowMessage({
            type: "file-error",
            requestId: message.requestId,
            fileId: message.fileId,
            scope: message.scope,
            commitSha: message.commitSha,
            message: "Unknown file requested.",
          });
          return;
        }

        try {
          const contents = await loadContents(file, message.scope, message.commitSha);
          sendWindowMessage({
            type: "file-data",
            requestId: message.requestId,
            fileId: message.fileId,
            scope: message.scope,
            commitSha: message.commitSha,
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
            commitSha: message.commitSha,
            message: messageText,
          });
        }
      };

      const handleRunAiReview = async (message: ReviewRunAiReviewPayload): Promise<void> => {
        if (aiReviewInFlight) {
          sendWindowMessage({
            type: "ai-review-error",
            requestId: message.requestId,
            message: "An AI review is already running.",
            progress: createAiReviewFailedProgress(analysis, "An AI review is already running.", aiReviewConfig),
          });
          return;
        }

        aiReviewInFlight = true;
        try {
          const result = await runAiReview(ctx, dataset, analysis, {
            getFilePatch: loadFilePatch,
            config: aiReviewConfig,
            onProgress: (progress) => {
              if (!canUpdateReviewWindow()) return;
              sendWindowMessage({
                type: "ai-review-progress",
                requestId: message.requestId,
                progress,
              });
            },
            onPartialResult: (partial) => {
              if (!canUpdateReviewWindow()) return;
              analysis = partial.analysis;
              windowController?.updateProtocolContext(rendererProtocolContext(files, dataset.commits, analysis, reviewMap));
              queueSessionSave({
                ...(sessionSnapshot ?? {}),
                analysis,
              });
              sendWindowMessage({
                type: "ai-review-partial-result",
                requestId: message.requestId,
                chapterId: partial.chapterId,
                analysis: partial.analysis,
                progress: partial.progress,
              });
            },
          });
          if (!canUpdateReviewWindow()) return;
          analysis = result.analysis;
          windowController?.updateProtocolContext(rendererProtocolContext(files, dataset.commits, analysis, reviewMap));
          queueSessionSave({
            ...(sessionSnapshot ?? {}),
            analysis,
          });
          sendWindowMessage({
            type: "ai-review-result",
            requestId: message.requestId,
            analysis: result.analysis,
            progress: result.progress,
          });
        } catch (error) {
          if (!canUpdateReviewWindow()) return;
          const messageText = error instanceof Error ? error.message : String(error);
          sendWindowMessage({
            type: "ai-review-error",
            requestId: message.requestId,
            message: messageText,
            progress: createAiReviewFailedProgress(analysis, messageText, aiReviewConfig),
          });
        } finally {
          aiReviewInFlight = false;
        }
      };

      const matchingCachedGithubContext = (): GitHubReviewContextSnapshot | undefined => {
        const github = dataset.source.github;
        const context = sessionSnapshot?.githubContext;
        if (github == null || context == null) return undefined;
        return context.owner === github.owner
          && context.repo === github.repo
          && context.pullNumber === github.number
          && context.reviewedHeadSha === dataset.source.headRevision
          ? context
          : undefined;
      };

      const refreshGithubContext = (): Promise<GitHubReviewContextSnapshot> => {
        if (githubContextInFlight != null) return githubContextInFlight;
        const github = dataset.source.github;
        const reviewedHeadSha = dataset.source.headRevision;
        if (github == null || reviewedHeadSha == null) {
          return Promise.reject(new Error("This review source has no GitHub pull request context."));
        }
        githubContextInFlight = fetchGitHubReviewContext(pi, dataset.workingRoot, {
          owner: github.owner,
          repo: github.repo,
          pullNumber: github.number,
          reviewedHeadSha,
        }).finally(() => { githubContextInFlight = null; });
        return githubContextInFlight;
      };

      const safeGithubContextError = (error: unknown): string => {
        const message = error instanceof Error ? error.message : String(error);
        return /auth|authentication|login/i.test(message)
          ? "GitHub authentication is required. Run gh auth login."
          : "GitHub review context could not be loaded.";
      };

      const handleRefreshGithubContext = async (message: ReviewRefreshGitHubContextPayload): Promise<void> => {
        try {
          const context = await refreshGithubContext();
          if (!canUpdateReviewWindow()) return;
          const nextSnapshot = { ...(sessionSnapshot ?? {}), githubContext: context };
          queueSessionSave(nextSnapshot);
          if (!await flushSessionSave()) throw new Error("Could not save refreshed GitHub review context.");
          if (!canUpdateReviewWindow()) return;
          sendWindowMessage({ type: "github-context-result", requestId: message.requestId, ok: true, context });
        } catch (error) {
          if (!canUpdateReviewWindow()) return;
          const messageText = safeGithubContextError(error);
          sendWindowMessage({
            type: "github-context-result",
            requestId: message.requestId,
            ok: false,
            message: messageText,
            ...(matchingCachedGithubContext() == null ? {} : { cachedContext: matchingCachedGithubContext() }),
          });
        }
      };

      const handleOpenExternalUrl = async (message: ReviewOpenExternalUrlPayload): Promise<void> => {
        try {
          const url = new URL(message.url);
          if (url.protocol !== "https:") return;
          const result = await pi.exec("open", [url.href], { cwd: dataset.workingRoot, timeout: 30_000 });
          if (result.code !== 0) ctx.ui.notify("Could not open the GitHub link.", "warning");
        } catch {
          ctx.ui.notify("Could not open the GitHub link.", "warning");
        }
      };

      const onMessage = (data: unknown): void => {
        const message = data as ReviewWindowMessage;
        if (isSaveSessionPayload(message)) {
          queueSessionSave(mergeRendererSessionCheckpoint(sessionSnapshot, message.snapshot), message.requestId);
          return;
        }
        if (isCheckpointSessionPayload(message)) {
          checkpointRendererSession(message.snapshot);
          return;
        }
        if (isRunAiReviewPayload(message)) {
          void handleRunAiReview(message);
          return;
        }
        if (isRefreshGitHubContextPayload(message)) {
          void handleRefreshGithubContext(message);
          return;
        }
        if (isOpenExternalUrlPayload(message)) {
          void handleOpenExternalUrl(message);
          return;
        }
        if (isPublishPayload(message)) {
          handlePublishGitHubReview(message);
          return;
        }
        if (isRequestFilePayload(message)) {
          void handleRequestFile(message);
          return;
        }
        if (isSubmitPayload(message) || isCancelPayload(message)) {
          if (isSubmitPayload(message)) {
            queueSessionSave(snapshotFromSubmit(message));
          }
          lifecycle.callbacks.onAuthenticatedTerminal(message);
        }
      };

      try {
        windowController = createReviewWindowController({
          window,
          shellPath: getReviewShellPath(),
          title,
          bootstrap: reviewData,
          protocol: rendererProtocolContext(files, dataset.commits, analysis, reviewMap),
          onMessage,
          onClosed: lifecycle.callbacks.onRendererClosed,
          onError: lifecycle.callbacks.onControllerError,
        });
        windowController.start();

        if (reviewMap.status !== "semantic" && reviewMap.status !== "semantic-repaired") {
          const scoutCache = new Map<string, string>();
          const focusedFileById = new Map(focusedFiles.map((file) => [file.id, file]));
          void (async () => {
            const result = await runSemanticReviewMap({
              sourceFingerprint: fingerprint.hash,
              strategyVersion: "semantic-map-v1",
              units,
              provisionalMap: reviewMap,
              runScouts: async () => await runReviewMapScouts({
                sourceFingerprint: fingerprint.hash,
                strategyVersion: "semantic-map-v1",
                units,
                getPatch: async (unit) => {
                  const file = focusedFileById.get(unit.fileId);
                  if (file == null) throw new Error(`Cannot load patch for unknown review unit file ${unit.fileId}.`);
                  return await loadFilePatch(file);
                },
                complete: async (input) => await completeStructuredText({
                  ctx,
                  route: aiReviewConfig.mapPhases.scout,
                  systemPrompt: REVIEW_MAP_SCOUT_PROMPT,
                  input,
                  phase: "map.scout",
                  depth: aiReviewConfig.depth,
                }),
                cache: scoutCache,
                maxInputChars: aiReviewConfig.maxChapterPatchChars,
                concurrency: aiReviewConfig.parallelChapterReviews,
              }),
              plan: async (facts, repairInstructions) => {
                const baseInput = JSON.parse(buildReviewMapPlannerInput(dataset, units, facts)) as Record<string, unknown>;
                return await completeStructuredText({
                  ctx,
                  route: aiReviewConfig.mapPhases.planner,
                  systemPrompt: REVIEW_MAP_PLANNER_PROMPT,
                  input: JSON.stringify({ ...baseInput, ...(repairInstructions == null ? {} : { repairInstructions }) }),
                  phase: "map.planner",
                  depth: aiReviewConfig.depth,
                });
              },
              criticize: async (planJson, scoutDiagnostics) => await completeStructuredText({
                ctx,
                route: aiReviewConfig.mapPhases.critic,
                systemPrompt: REVIEW_MAP_CRITIC_PROMPT,
                input: JSON.stringify({ proposal: JSON.parse(planJson), scoutDiagnostics }),
                phase: "map.critic",
                depth: aiReviewConfig.depth,
              }),
              onProgress: (progress) => sendWindowMessage({ type: "review-map-progress", progress }),
            });
            if (!canUpdateReviewWindow()) return;
            reviewMap = result;
            analysis = {
              ...analysis,
              chapters: result.chapters,
              coverage: {
                fileCount: result.coverage.fileCount,
                originalLineCount: result.coverage.originalLineCount,
                modifiedLineCount: result.coverage.modifiedLineCount,
                unmappedFileCount: result.coverage.unmappedFileCount,
                unmappedOriginalLineCount: result.coverage.unmappedOriginalLineCount,
                unmappedModifiedLineCount: result.coverage.unmappedModifiedLineCount,
              },
            };
            reviewData.map = result;
            reviewData.analysis = analysis;
            sessionSnapshot = { ...(sessionSnapshot ?? {}), map: result };
            queueSessionSave(sessionSnapshot);
            if (!await flushSessionSave() || !canUpdateReviewWindow()) return;
            windowController?.updateProtocolContext(rendererProtocolContext(files, dataset.commits, analysis, result));
            sendWindowMessage({ type: "review-map-result", map: result });
          })().catch((error) => {
            if (canUpdateReviewWindow()) ctx.ui.notify(`Semantic review map failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
          });
        }
      } catch (error) {
        const controllerError = error instanceof Error ? error : new Error(String(error));
        lifecycle.callbacks.onControllerError(controllerError);
      }

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        await lifecycle.onTerminalEscape().catch(() => null);
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      const saveOk = await lifecycle.persist();
      closeActiveWindow();

      if (message == null) {
        ctx.ui.notify(saveOk ? "Review saved." : "Review closed; autosave failed.", saveOk ? "info" : "warning");
        return;
      }

      if (message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    } finally {
      if (activeReviewLifecycle === reviewLifecycle) {
        activeReviewLifecycle = null;
      }
      if (activeReviewCompletion === reviewCompletion) {
        activeReviewCompletion = null;
      }
      finishActiveReview();
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native review window with git diff, last commit, and all files scopes",
    handler: async (args, ctx) => {
      await reviewRepository(args.trim() === "" ? [] : args.trim().split(/\s+/), ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    const reviewCompletion = activeReviewCompletion;
    const lifecycle = activeReviewLifecycle;
    activeWaitingUIDismiss?.();
    if (lifecycle == null) {
      closeActiveWindow();
    } else {
      await lifecycle.onSessionShutdown().catch(() => undefined);
    }
    await reviewCompletion?.catch(() => undefined);
  });
}
