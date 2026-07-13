import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/language/css/monaco.contribution.js";
import "monaco-editor/esm/vs/language/html/monaco.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import editorWorkerSource from "review-worker:editor";
import jsonWorkerSource from "review-worker:json";
import cssWorkerSource from "review-worker:css";
import htmlWorkerSource from "review-worker:html";
import typescriptWorkerSource from "review-worker:typescript";
import { createCommentEditorSavePolicy } from "./comment-editor-save-policy.js";
import { createCommentEditBuffer } from "./comment-edit-buffer.js";
import { replaceDiffEditorModels } from "./model-lifecycle.js";
import { applyAuthoritativePublishedCommentState } from "./publish-comment-state.js";
import { expandDisclosure, isDisclosureExpanded, toggleDisclosure } from "./review-disclosure-state.js";
import { isFileCanvasActive } from "./review-navigation-state.js";
import { isFileReviewComplete, nextReviewVisit, reconcileReviewMapState } from "./review-visit-state.js";
import { createSessionSaveScheduler } from "./session-save-scheduler.js";
import { renderSafeMarkdown, safeExternalUrl } from "./safe-markdown.js";
import {
  createGitHubThreadDisclosureState,
  locateCurrentThread,
  threadItemsForFilter,
  unresolvedThreadCount,
} from "./github-review-context.js";

const localWorkerSources = Object.freeze({
  editor: editorWorkerSource,
  json: jsonWorkerSource,
  css: cssWorkerSource,
  html: htmlWorkerSource,
  typescript: typescriptWorkerSource,
});
const workerObjectUrls = new Map();
const workerProbe = Object.freeze({ __piDiffReviewWorkerProbe: "v1" });

function workerKindForLabel(label) {
  return {
    json: "json",
    css: "css",
    scss: "css",
    less: "css",
    html: "html",
    handlebars: "html",
    razor: "html",
    typescript: "typescript",
    javascript: "typescript",
  }[label] || "editor";
}

function workerObjectUrl(kind) {
  const existing = workerObjectUrls.get(kind);
  if (existing) return existing;
  const source = localWorkerSources[kind];
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  workerObjectUrls.set(kind, url);
  return url;
}

function createLocalMonacoWorker(label) {
  const kind = workerKindForLabel(label);
  return { kind, worker: new Worker(workerObjectUrl(kind)) };
}

function disposeWorkerObjectUrls() {
  for (const url of workerObjectUrls.values()) URL.revokeObjectURL(url);
  workerObjectUrls.clear();
}

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    return createLocalMonacoWorker(label).worker;
  },
};

async function verifyLocalWorkers() {
  const workers = [
    ["editor", "editorWorkerService"],
    ["json", "json"],
    ["css", "css"],
    ["html", "html"],
    ["typescript", "typescript"],
  ];
  const verified = [];
  for (const [name, label] of workers) {
    const { worker } = createLocalMonacoWorker(label);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`${name} worker probe timed out.`)), 4_000);
      const onMessage = (event) => {
        if (event.data?.__piDiffReviewWorkerProbe !== "v1") return;
        finish();
      };
      const onError = (event) => finish(new Error(`${name} worker failed: ${event.message || "unknown error"}`));
      const finish = (error) => {
        clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.terminate();
        if (error) reject(error);
        else resolve();
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(workerProbe);
    });
    verified.push(name);
  }
  return verified;
}

window.__reviewWorkerDiagnostics = Object.freeze({
  verifyLocalWorkers,
  activeObjectUrlCount: () => workerObjectUrls.size,
  dispose: disposeWorkerObjectUrls,
});
window.addEventListener("beforeunload", disposeWorkerObjectUrls);

let rendererSession = null;
let reviewAppStarted = false;

function canSendRendererMessage() {
  return rendererSession != null && typeof window.glimpse?.send === "function";
}

function sendRendererMessage(message) {
  if (!canSendRendererMessage()) return false;
  window.glimpse.send({
    protocol: 1,
    sessionId: rendererSession.sessionId,
    capability: rendererSession.capability,
    message,
  });
  return true;
}

function startReviewApp(reviewData) {
const restoredSession = reviewData.session?.snapshot || {};
const restoredFindingIds = new Set((reviewData.analysis?.findings || []).map((finding) => finding.id));

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function objectOrEmpty(value) {
  return isPlainObject(value) ? value : {};
}

function booleanMapOrEmpty(value) {
  return Object.fromEntries(Object.entries(objectOrEmpty(value)).filter((entry) => typeof entry[1] === "boolean"));
}

function stringSetOrEmpty(value) {
  if (Array.isArray(value)) return new Set(value.filter((item) => typeof item === "string"));
  return new Set(Object.entries(objectOrEmpty(value)).filter((entry) => entry[1] === true).map(([key]) => key));
}

function commentsOrEmpty(value) {
  return Array.isArray(value) ? value.filter((comment) => isPlainObject(comment) && typeof comment.id === "string") : [];
}

function activeInsightOrDefault(value) {
  if (!isPlainObject(value)) return { type: "default", id: null };
  if (!["default", "chapter", "finding", "comment"].includes(value.type)) return { type: "default", id: null };
  return {
    type: value.type,
    id: typeof value.id === "string" ? value.id : null,
  };
}

function restoredFindingStatuses() {
  const savedStatuses = objectOrEmpty(restoredSession.findingStatuses);
  return Object.fromEntries((reviewData.analysis?.findings || []).map((finding) => [
    finding.id,
    typeof savedStatuses[finding.id] === "string" ? savedStatuses[finding.id] : finding.status || "new",
  ]));
}

function restoredAcceptedFindingComments() {
  return Object.fromEntries(
    Object.entries(objectOrEmpty(restoredSession.acceptedFindingComments))
      .filter(([findingId, body]) => restoredFindingIds.has(findingId) && typeof body === "string"),
  );
}

function defaultScope() {
  if (reviewData.files.some((file) => file.inGitDiff)) return "git-diff";
  if (reviewData.files.some((file) => file.inLastCommit)) return "last-commit";
  if (reviewData.commits?.length > 0) return "commit";
  return "all-files";
}

function hasFilesForScope(scope, commitSha) {
  switch (scope) {
    case "git-diff": return reviewData.files.some((file) => file.inGitDiff);
    case "last-commit": return reviewData.files.some((file) => file.inLastCommit);
    case "commit": return !!commitSha && reviewData.files.some((file) => file.commitComparisons?.[commitSha]);
    case "all-files": return reviewData.files.some((file) => file.hasWorkingTreeFile);
    default: return false;
  }
}

const restoredCommitSha = typeof restoredSession.selectedCommitSha === "string" && reviewData.commits?.some((commit) => commit.sha === restoredSession.selectedCommitSha)
  ? restoredSession.selectedCommitSha
  : reviewData.commits?.[0]?.sha || null;
const initialScope = defaultScope();
const restoredScope = typeof restoredSession.currentScope === "string"
  && (restoredSession.currentScope !== "all-files" || initialScope === "all-files")
  && hasFilesForScope(restoredSession.currentScope, restoredCommitSha)
  ? restoredSession.currentScope
  : initialScope;
const restoredForCurrentDiff = reviewData.session?.status === "restored";
const restoredAiReviewCompleted = restoredForCurrentDiff && (restoredSession.aiReviewCompleted === true || (reviewData.analysis?.findings || []).length > 0);
const restoredAiReviewStatus = restoredForCurrentDiff && ["done", "failed"].includes(restoredSession.aiReviewStatus)
  ? restoredSession.aiReviewStatus
  : restoredAiReviewCompleted ? "done" : "idle";
const commentEditBuffer = createCommentEditBuffer();

const state = {
  activeFileId: typeof restoredSession.activeFileId === "string" ? restoredSession.activeFileId : null,
  activeSidebarTab: ["review-map", "files", "findings"].includes(restoredSession.activeSidebarTab) ? restoredSession.activeSidebarTab : "review-map",
  currentScope: restoredScope,
  comments: commentsOrEmpty(restoredSession.comments),
  overallComment: typeof restoredSession.overallComment === "string" ? restoredSession.overallComment : "",
  hideUnchanged: typeof restoredSession.hideUnchanged === "boolean" ? restoredSession.hideUnchanged : false,
  wrapLines: typeof restoredSession.wrapLines === "boolean" ? restoredSession.wrapLines : true,
  collapsedDirs: {},
  reviewedFiles: booleanMapOrEmpty(restoredSession.reviewedFiles),
  reviewedChapters: booleanMapOrEmpty(restoredSession.reviewedChapters),
  reviewedVisits: booleanMapOrEmpty(restoredSession.reviewedVisits),
  activeVisitId: typeof restoredSession.activeVisitId === "string" ? restoredSession.activeVisitId : null,
  findingStatuses: restoredFindingStatuses(),
  acceptedFindingComments: restoredAcceptedFindingComments(),
  scrollPositions: {},
  sidebarCollapsed: typeof restoredSession.sidebarCollapsed === "boolean" ? restoredSession.sidebarCollapsed : false,
  fileFilter: "",
  activeInsight: activeInsightOrDefault(restoredSession.activeInsight),
  selectedCommitSha: restoredCommitSha,
  fileContents: {},
  fileErrors: {},
  pendingRequestIds: {},
  activeDiffSide: "modified",
  activeDiffLine: null,
  activeCanvas: "file",
  pendingHunkFocus: null,
  pendingFindingFocus: null,
  editingCommentIds: new Set(),
  collapsedCommentIds: new Set(),
  collapsedFindingIds: new Set(),
  dismissedFindingLocationKeys: stringSetOrEmpty(restoredSession.dismissedFindingLocationKeys),
  publishRequestId: null,
  aiReviewCompleted: restoredAiReviewCompleted,
  aiReview: {
    requestId: null,
    status: restoredAiReviewStatus,
    message: restoredAiReviewStatus === "failed"
      ? reviewData.analysis?.message || "AI analysis failed."
      : restoredAiReviewCompleted
      ? reviewData.analysis?.message || "AI analysis complete."
      : "AI analysis will run in the background.",
    progress: null,
    config: reviewData.aiReviewConfig || null,
  },
  reviewMapProgress: null,
  githubContext: restoredSession.githubContext || null,
  githubContextRequestId: null,
  githubContextStatus: "idle",
  githubContextMessage: "",
  githubContextTab: "overview",
  githubContextFilter: "open",
  githubThreadDisclosure: createGitHubThreadDisclosureState(),
  pendingGithubThreadFocus: null,
  expandedGithubContextItemIds: new Set(),
};

const sidebarEl = document.getElementById("sidebar");
const mainPaneEl = document.getElementById("main-pane");
const sidebarTitleEl = document.getElementById("sidebar-title");
const sidebarSearchInputEl = document.getElementById("sidebar-search-input");
const toggleSidebarButton = document.getElementById("toggle-sidebar-button");
const tabReviewMapButton = document.getElementById("tab-review-map-button");
const tabFilesButton = document.getElementById("tab-files-button");
const tabFindingsButton = document.getElementById("tab-findings-button");
const scopeDiffButton = document.getElementById("scope-diff-button");
const scopeLastCommitButton = document.getElementById("scope-last-commit-button");
const scopeCommitButton = document.getElementById("scope-commit-button");
const scopeAllButton = document.getElementById("scope-all-button");
const scopeControlsEl = document.getElementById("scope-controls");
const commitSelectEl = document.getElementById("commit-select");
const windowTitleEl = document.getElementById("window-title");
const repoRootEl = document.getElementById("repo-root");
const fileTreeEl = document.getElementById("file-tree");
const summaryEl = document.getElementById("summary");
const currentFileLabelEl = document.getElementById("current-file-label");
const modeHintEl = document.getElementById("mode-hint");
const fileCommentsContainer = document.getElementById("file-comments-container");
const editorContainerEl = document.getElementById("editor-container");
const chapterBriefContainerEl = document.getElementById("chapter-brief-container");
const insightPanelEl = document.getElementById("insight-panel");
const insightPanelTitleEl = document.getElementById("insight-panel-title");
const insightContentEl = document.getElementById("insight-content");
const sourceLabelEl = document.getElementById("source-label");
const analysisStatusEl = document.getElementById("analysis-status");
const submitButton = document.getElementById("submit-button");
const autosaveStatusButton = document.getElementById("autosave-status");
const sessionNoticeEl = document.getElementById("session-notice");
const fileCommentButton = document.getElementById("file-comment-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleUnchangedButton = document.getElementById("toggle-unchanged-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");
const githubThreadCountButton = document.getElementById("github-thread-count");
const prContextDrawerEl = document.getElementById("pr-context-drawer");
const prContextContentEl = document.getElementById("pr-context-content");
const prContextSyncEl = document.getElementById("pr-context-sync");
const prContextOverviewTab = document.getElementById("pr-context-overview-tab");
const prContextThreadsTab = document.getElementById("pr-context-threads-tab");
const prContextRefreshButton = document.getElementById("pr-context-refresh");
const prContextCloseButton = document.getElementById("pr-context-close");
let prContextOpener = null;

function shortPathName(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || "repository";
}

function workflowTitleParts() {
  const github = reviewData.source?.github;
  if (github) {
    return {
      title: `PR #${github.number} review`,
      subtitle: `${github.owner}/${github.repo} · ${github.title}`,
      documentTitle: `Review PR #${github.number} · ${github.owner}/${github.repo}`,
    };
  }
  const repoName = shortPathName(reviewData.repoRoot);
  return {
    title: `${scopeLabel(defaultScope())} review`,
    subtitle: `${repoName} · ${reviewData.repoRoot || ""}`,
    documentTitle: `Diff review · ${repoName}`,
  };
}

const workflowTitle = workflowTitleParts();
repoRootEl.textContent = workflowTitle.subtitle;
windowTitleEl.textContent = workflowTitle.title;
document.title = workflowTitle.documentTitle;
if (reviewData.source?.github) {
  windowTitleEl.classList.remove("cursor-default");
  windowTitleEl.classList.add("cursor-pointer", "hover:text-blue-300");
  windowTitleEl.innerHTML = `${escapeHtml(workflowTitle.title)} <span class="text-[10px] text-review-muted">⌄</span>`;
  windowTitleEl.title = "Open pull request context (P)";
}

function currentUnresolvedGithubThreads() {
  return threadItemsForFilter(state.githubContext, "open").map((entry) => entry.item);
}

function updateGithubThreadCount() {
  if (!reviewData.source?.github) return;
  const count = unresolvedThreadCount(state.githubContext);
  githubThreadCountButton.textContent = `◌ ${count}`;
  githubThreadCountButton.classList.remove("hidden");
}

function isPrContextOpen() {
  return !prContextDrawerEl.classList.contains("hidden");
}

function closePrContext() {
  if (!isPrContextOpen()) return;
  prContextDrawerEl.classList.add("hidden");
  prContextDrawerEl.setAttribute("aria-hidden", "true");
  const opener = prContextOpener;
  prContextOpener = null;
  if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
}

function githubContextTimeLabel() {
  if (state.githubContextStatus === "loading") return "Refreshing GitHub context...";
  if (state.githubContextStatus === "failed") return state.githubContextMessage || "Refresh failed";
  const fetchedAt = state.githubContext?.fetchedAt ? new Date(state.githubContext.fetchedAt) : null;
  return fetchedAt && !Number.isNaN(fetchedAt.getTime()) ? `Last synced ${fetchedAt.toLocaleTimeString()}` : "Not synced yet";
}

function renderPrContext() {
  if (!reviewData.source?.github) return;
  const github = reviewData.source.github;
  prContextOverviewTab.setAttribute("aria-selected", String(state.githubContextTab === "overview"));
  prContextThreadsTab.setAttribute("aria-selected", String(state.githubContextTab === "threads"));
  prContextSyncEl.textContent = githubContextTimeLabel();
  if (state.githubContextTab === "overview") {
    prContextContentEl.innerHTML = `
      <div class="text-base font-semibold text-white">${escapeHtml(github.title)}</div>
      <div class="mt-1 text-xs text-review-muted">${escapeHtml(github.author || "Unknown author")} · ${escapeHtml(github.baseRefName)} ← ${escapeHtml(github.headRefName)} · ${escapeHtml(github.state || "")}</div>
      <div class="review-context-markdown mt-5">${renderSafeMarkdown(github.body || "No pull request description provided.")}</div>
      <button type="button" data-external-url="${escapeHtml(github.url)}" class="mt-5 cursor-pointer text-xs font-medium text-blue-400 hover:text-blue-300">Open on GitHub ↗</button>
    `;
  } else {
    const context = state.githubContext;
    const open = currentUnresolvedGithubThreads();
    const items = threadItemsForFilter(context, state.githubContextFilter);
    prContextContentEl.innerHTML = `
      <div class="mb-3 flex items-center gap-1 rounded-md bg-[#010409] p-1">
        <button type="button" data-context-filter="open" class="flex-1 cursor-pointer rounded px-2 py-1 text-xs ${state.githubContextFilter === "open" ? "bg-[#21262d] text-white" : "text-review-muted"}">Open ${open.length}</button>
        <button type="button" data-context-filter="all" class="flex-1 cursor-pointer rounded px-2 py-1 text-xs ${state.githubContextFilter === "all" ? "bg-[#21262d] text-white" : "text-review-muted"}">All</button>
      </div>
      ${items.length === 0 ? `<div class="py-8 text-center text-sm text-review-muted">${state.githubContextStatus === "loading" ? "Loading GitHub threads..." : "No review threads to show."}</div>` : items.map(({ kind, item }) => {
        const comment = kind === "thread" ? item.comments?.[item.comments.length - 1] : item;
        const threadLine = item.side === "original" ? item.originalLine : item.line;
        const location = kind === "thread" ? `${item.path}${threadLine ? `:${threadLine}` : ""}` : kind === "review" ? `Review · ${item.state}` : "Conversation";
        const status = kind === "thread" && item.isOutdated ? "Outdated" : kind === "thread" && item.isResolved ? "Resolved" : "";
        const itemKey = `${kind}:${item.id}`;
        const canNavigate = kind === "thread" && !item.isOutdated;
        const expanded = state.expandedGithubContextItemIds.has(itemKey);
        const expandedBody = kind === "thread"
          ? (item.comments || []).map((entry) => `<div class="border-t border-review-border py-2 first:border-0"><div class="text-[10px] text-review-muted">${escapeHtml(entry.author || "ghost")}</div><div class="review-context-markdown mt-1">${renderSafeMarkdown(entry.body || "")}</div></div>`).join("")
          : `<div class="review-context-markdown mt-2 border-t border-review-border pt-2">${renderSafeMarkdown(item.body || "")}</div>`;
        return `<div class="mb-2 overflow-hidden rounded-md border border-review-border bg-[#010409]">
          <button type="button" ${canNavigate ? `data-github-thread-id="${escapeHtml(item.id)}"` : `data-context-item-id="${escapeHtml(itemKey)}"`} class="block w-full cursor-pointer px-3 py-3 text-left hover:bg-[#161b22]">
            <div class="flex items-center justify-between gap-3 text-[10px] text-review-muted"><span class="truncate">${escapeHtml(location)}</span>${status ? `<span>${status}</span>` : ""}</div>
            <div class="mt-1 truncate text-xs text-review-text">${escapeHtml((comment?.body || "No comment text.").replace(/\s+/g, " "))}</div>
            <div class="mt-2 text-[10px] text-review-muted">${escapeHtml(comment?.author || "ghost")}${kind === "thread" ? ` · ${item.comments?.length || 0} comment(s)` : ""}</div>
          </button>
          ${expanded ? `<div class="px-3 pb-3">${expandedBody}</div>` : ""}
        </div>`;
      }).join("")}
    `;
  }
}

function openPrContext(tab = "overview", opener = document.activeElement) {
  if (!reviewData.source?.github) return;
  prContextOpener = opener;
  state.githubContextTab = tab;
  prContextDrawerEl.classList.remove("hidden");
  prContextDrawerEl.setAttribute("aria-hidden", "false");
  renderPrContext();
  (tab === "threads" ? prContextThreadsTab : prContextOverviewTab).focus();
}

function refreshGithubContext() {
  if (!reviewData.source?.github || state.githubContextStatus === "loading") return;
  const requestId = `github-context:${Date.now()}:${++requestSequence}`;
  state.githubContextRequestId = requestId;
  state.githubContextStatus = "loading";
  state.githubContextMessage = "";
  if (isPrContextOpen()) renderPrContext();
  sendRendererMessage({ type: "refresh-github-context", requestId });
}

function openGithubThread(threadId) {
  const thread = state.githubContext?.threads?.find((item) => item.id === threadId);
  if (!thread || thread.isOutdated) return;
  const matches = githubFilesByPath().get(thread.path) || [];
  if (matches.length !== 1) return;
  saveCurrentScrollPosition();
  state.currentScope = "git-diff";
  state.activeCanvas = "file";
  state.activeFileId = matches[0].id;
  state.pendingGithubThreadFocus = thread.id;
  state.githubThreadDisclosure.expand(thread.id);
  closePrContext();
  renderAll({ restoreFileScroll: false });
  ensureFileLoaded(matches[0].id, "git-diff");
  requestAnimationFrame(applyPendingGithubThreadFocus);
}

function applyPendingGithubThreadFocus() {
  const threadId = state.pendingGithubThreadFocus;
  if (!threadId || !isActiveFileReady()) return;
  const thread = state.githubContext?.threads?.find((item) => item.id === threadId);
  const location = thread ? locateGithubThread(thread) : null;
  if (!thread || !location || location.fileId !== state.activeFileId) {
    state.pendingGithubThreadFocus = null;
    return;
  }
  state.pendingGithubThreadFocus = null;
  syncViewZones();
  updateDecorations();
  focusDiffLine(location.side, location.line, location.line);
  requestAnimationFrame(() => {
    const node = document.querySelector(`[data-github-thread-id="${CSS.escape(thread.id)}"]`);
    node?.classList.add("review-github-thread-pulse");
    setTimeout(() => node?.classList.remove("review-github-thread-pulse"), 800);
  });
}

function updateSessionNotice() {
  const labels = [];
  const details = [];
  if (reviewData.session?.publishWarning) {
    labels.push("Publishing blocked");
    details.push(reviewData.session.publishWarning);
  }
  if (reviewData.session?.recoveryPath) {
    labels.push("Recovery saved");
    details.push(`Previous local review state: ${reviewData.session.recoveryPath}`);
  }
  sessionNoticeEl.textContent = labels.join(" • ");
  sessionNoticeEl.title = details.join("\n");
  sessionNoticeEl.className = labels.length === 0
    ? "hidden"
    : "shrink-0 text-[10px] font-medium text-[#d29922]";
}

updateSessionNotice();

function workflowCrumbLabel() {
  const github = reviewData.source?.github;
  return github ? `PR #${github.number}` : workflowTitle.title;
}

function setInsightBreadcrumb(parts) {
  insightPanelTitleEl.textContent = [workflowCrumbLabel(), ...parts].filter(Boolean).join(" > ");
}

let monacoApi = null;
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let originalDecorations = [];
let modifiedDecorations = [];
let originalKeyboardDecorations = [];
let modifiedKeyboardDecorations = [];
let activeViewZones = [];
let editorResizeObserver = null;
let requestSequence = 0;
let saveRequestSequence = 0;
let latestSaveRequestId = null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function buildSessionSnapshot() {
  return {
    overallComment: state.overallComment,
    comments: commentEditBuffer.snapshot(state.comments),
    acceptedFindingComments: state.acceptedFindingComments,
    findingStatuses: state.findingStatuses,
    reviewedFiles: state.reviewedFiles,
    reviewedChapters: state.reviewedChapters,
    reviewedVisits: state.reviewedVisits,
    activeFileId: state.activeFileId,
    activeVisitId: state.activeVisitId,
    activeSidebarTab: state.activeSidebarTab,
    currentScope: state.currentScope,
    selectedCommitSha: state.selectedCommitSha,
    activeInsight: state.activeInsight,
    hideUnchanged: state.hideUnchanged,
    wrapLines: state.wrapLines,
    sidebarCollapsed: state.sidebarCollapsed,
    aiReviewCompleted: state.aiReviewCompleted,
    aiReviewStatus: ["done", "failed"].includes(state.aiReview.status) ? state.aiReview.status : undefined,
    dismissedFindingLocationKeys: [...state.dismissedFindingLocationKeys],
    updatedAt: new Date().toISOString(),
  };
}

function setAutosaveStatus(status, message, detail = "") {
  if (!autosaveStatusButton) return;
  autosaveStatusButton.textContent = message;
  autosaveStatusButton.dataset.status = status;
  autosaveStatusButton.title = detail || message;
  autosaveStatusButton.disabled = status !== "failed";
  autosaveStatusButton.className = {
    saving: "shrink-0 cursor-default rounded px-1.5 py-0.5 text-[10px] font-medium text-review-muted",
    saved: "shrink-0 cursor-default rounded px-1.5 py-0.5 text-[10px] font-medium text-[#3fb950]",
    failed: "shrink-0 cursor-pointer rounded bg-[#f85149]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#ff7b72] hover:bg-[#f85149]/15",
    blocked: "shrink-0 cursor-default rounded bg-[#d29922]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#e3b341]",
  }[status] || "shrink-0 cursor-default rounded px-1.5 py-0.5 text-[10px] font-medium text-review-muted";
}

function saveSessionNow(options = {}) {
  if (!canSendRendererMessage()) return;
  syncCommentBodiesFromDOM();
  const requestId = `save:${Date.now()}:${++saveRequestSequence}`;
  latestSaveRequestId = requestId;
  if (options.showStatus !== false) setAutosaveStatus("saving", "Saving...");
  sendRendererMessage({
    type: "save-session",
    requestId,
    snapshot: buildSessionSnapshot(),
  });
}

const sessionSaveScheduler = createSessionSaveScheduler(() => saveSessionNow(), 500);

function scheduleSessionSave() {
  if (!canSendRendererMessage()) return;
  syncCommentBodiesFromDOM();
  sendRendererMessage({
    type: "checkpoint-session",
    snapshot: buildSessionSnapshot(),
  });
  sessionSaveScheduler.schedule();
}

function inferLanguage(path) {
  if (!path) return "plaintext";
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt")) return "kotlin";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  return "plaintext";
}

function scopeLabel(scope) {
  switch (scope) {
    case "git-diff": return "Git diff";
    case "last-commit": return "Last commit";
    case "commit": return "Commit history";
    default: return "All files";
  }
}

function scopeHint(scope) {
  switch (scope) {
    case "git-diff":
      return "Review changed hunks. Click line numbers to stage comments.";
    case "last-commit":
      return "Review the last commit against its parent.";
    case "commit":
      return "Review the selected commit against its parent.";
    default:
      return "Review the current working tree snapshot.";
  }
}

function statusLabel(status) {
  if (!status) return "";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusBadgeClass(status) {
  switch (status) {
    case "added": return "text-[#3fb950]";
    case "deleted": return "text-[#f85149]";
    case "renamed": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function countLineRanges(ranges) {
  return (ranges || []).reduce((total, range) => total + Math.max(0, range.end - range.start + 1), 0);
}

function diffstatCountsFromComparison(comparison) {
  if (!comparison) return null;
  return {
    added: Number.isSafeInteger(comparison.addedLines)
      ? comparison.addedLines
      : countLineRanges(comparison.commentableModifiedLines),
    deleted: Number.isSafeInteger(comparison.deletedLines)
      ? comparison.deletedLines
      : countLineRanges(comparison.commentableOriginalLines),
  };
}

function addDiffstatCounts(left, right) {
  return {
    added: (left?.added || 0) + (right?.added || 0),
    deleted: (left?.deleted || 0) + (right?.deleted || 0),
  };
}

function fileDiffstatCounts(file, scope = state.currentScope) {
  return diffstatCountsFromComparison(getScopeComparison(file, scope));
}

function scopedDiffstatCounts(files, scope = state.currentScope) {
  return files.reduce((total, file) => addDiffstatCounts(total, fileDiffstatCounts(file, scope)), { added: 0, deleted: 0 });
}

function chapterDiffstatCounts(chapter) {
  return {
    added: chapterRangeLineCount(chapter, "modified"),
    deleted: chapterRangeLineCount(chapter, "original"),
  };
}

function coverageDiffstatCounts(coverage) {
  if (!coverage) return null;
  return {
    added: coverage.modifiedLineCount || 0,
    deleted: coverage.originalLineCount || 0,
  };
}

function diffstatHtml(counts, options = {}) {
  if (!counts) return "";
  const added = Math.max(0, Number(counts.added || 0));
  const deleted = Math.max(0, Number(counts.deleted || 0));
  if (!options.showZero && added === 0 && deleted === 0) return "";

  const blockCount = Number.isInteger(options.blocks) ? Math.max(0, options.blocks) : 5;
  const total = added + deleted;
  let addBlocks = 0;
  let delBlocks = 0;

  if (total > 0) {
    addBlocks = added > 0 ? Math.max(1, Math.round((added / total) * blockCount)) : 0;
    delBlocks = deleted > 0 ? Math.max(1, Math.round((deleted / total) * blockCount)) : 0;

    while (addBlocks + delBlocks > blockCount) {
      if (addBlocks >= delBlocks && addBlocks > 1) {
        addBlocks -= 1;
      } else if (delBlocks > 1) {
        delBlocks -= 1;
      } else {
        break;
      }
    }
  }

  const neutralBlocks = Math.max(0, blockCount - addBlocks - delBlocks);
  const blocks = [
    ...Array.from({ length: addBlocks }, () => "diffstat-block diffstat-block-add"),
    ...Array.from({ length: delBlocks }, () => "diffstat-block diffstat-block-del"),
    ...Array.from({ length: neutralBlocks }, () => "diffstat-block"),
  ];
  const label = `${added} additions, ${deleted} deletions`;
  const compactClass = options.compact ? " diffstat-compact" : "";

  return `
    <span class="diffstat${compactClass}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
      <span class="diffstat-counts">
        <span class="diffstat-add">+${added}</span>
        <span class="diffstat-del">-${deleted}</span>
      </span>
      ${blockCount > 0 ? `<span class="diffstat-bars" aria-hidden="true">
        ${blocks.map((className) => `<span class="${className}"></span>`).join("")}
      </span>` : ""}
    </span>
  `;
}

function setSummary(summary, counts = null, progress = null) {
  const stats = diffstatHtml(counts, { compact: true });
  if (!progress) {
    summaryEl.innerHTML = `${stats ? `${stats}<span class="mx-1 text-review-muted">•</span>` : ""}<span>${escapeHtml(summary)}</span>`;
    return;
  }

  const total = Math.max(0, Number(progress.total || 0));
  const reviewed = Math.max(0, Math.min(total, Number(progress.reviewed || 0)));
  const percent = total > 0 ? Math.round((reviewed / total) * 100) : 0;
  const staged = Math.max(0, Number(progress.staged || 0));
  summaryEl.innerHTML = `
    <div class="flex min-w-0 items-center gap-2">
      ${stats ? `<span class="shrink-0">${stats}</span>` : ""}
      <span class="min-w-0 truncate">${escapeHtml(summary)}</span>
      <span class="shrink-0 rounded bg-[#161b22] px-1.5 py-0.5 text-[10px] font-medium text-review-muted">${reviewed}/${total} reviewed</span>
      <span class="shrink-0 rounded bg-[#161b22] px-1.5 py-0.5 text-[10px] font-medium text-review-muted">${staged} staged</span>
      <span class="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-[#30363d]" title="${reviewed}/${total} files reviewed">
        <span class="block h-full rounded-full bg-[#58a6ff]" style="width: ${percent}%"></span>
      </span>
    </div>
  `;
}

function chapterRangeLineCount(chapter, side) {
  return (chapter.ranges || [])
    .filter((range) => range.side === side)
    .reduce((total, range) => total + Math.max(0, range.endLine - range.startLine + 1), 0);
}

function coverageSummaryLabel(coverage) {
  if (!coverage) return "";
  const base = `${coverage.fileCount} changed file(s)`;
  if (coverage.unmappedFileCount === 0) return `${base} • 100% covered`;
  return `${base} • ${coverage.unmappedFileCount} file(s) in Unmapped diff`;
}

function humanizeToken(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function severityTextClass(severity) {
  switch (severity) {
    case "critical":
    case "high":
      return "text-[#f85149]";
    case "medium":
      return "text-[#d29922]";
    case "low":
      return "text-[#58a6ff]";
    default:
      return "text-review-muted";
  }
}

function severityAccentColor(severity) {
  switch (severity) {
    case "critical":
    case "high":
      return "#f85149";
    case "medium":
      return "#d29922";
    case "low":
      return "#58a6ff";
    default:
      return "#d2a8ff";
  }
}

function severityBadgeClass(severity) {
  switch (severity) {
    case "critical":
    case "high":
      return "shrink-0 whitespace-nowrap rounded bg-[#f85149]/10 px-2 py-0.5 text-[11px] font-medium text-[#ff7b72]";
    case "medium":
      return "shrink-0 whitespace-nowrap rounded bg-[#d29922]/10 px-2 py-0.5 text-[11px] font-medium text-[#e3b341]";
    case "low":
      return "shrink-0 whitespace-nowrap rounded bg-[#58a6ff]/10 px-2 py-0.5 text-[11px] font-medium text-[#79c0ff]";
    default:
      return "shrink-0 whitespace-nowrap rounded bg-[#30363d]/50 px-2 py-0.5 text-[11px] font-medium text-review-muted";
  }
}

function chapterPriorityLabel(priority) {
  switch (priority) {
    case "review-first": return "Review first";
    case "high-attention": return "High attention";
    case "low-attention": return "Low attention";
    case "reference": return "Reference";
    default: return "Standard";
  }
}

function chapterPriorityBadgeClass(priority) {
  switch (priority) {
    case "review-first":
      return "shrink-0 whitespace-nowrap rounded bg-[#8957e5]/12 px-2 py-0.5 text-[11px] font-medium text-[#d2a8ff]";
    case "high-attention":
      return "shrink-0 whitespace-nowrap rounded bg-[#d29922]/10 px-2 py-0.5 text-[11px] font-medium text-[#e3b341]";
    case "low-attention":
      return "shrink-0 whitespace-nowrap rounded bg-[#58a6ff]/10 px-2 py-0.5 text-[11px] font-medium text-[#79c0ff]";
    case "reference":
      return "shrink-0 whitespace-nowrap rounded bg-[#30363d]/50 px-2 py-0.5 text-[11px] font-medium text-review-muted";
    default:
      return "shrink-0 whitespace-nowrap rounded bg-[#238636]/10 px-2 py-0.5 text-[11px] font-medium text-[#7ee787]";
  }
}

function attentionTagsHtml(chapter) {
  return (chapter.attentionTags || [])
    .slice(0, 3)
    .map((tag) => `<span class="rounded bg-[#30363d]/45 px-1.5 py-0.5 text-[11px] font-medium text-review-muted">${escapeHtml(tag)}</span>`)
    .join("");
}

function reviewStatusBadgeClass(done) {
  return done
    ? "shrink-0 whitespace-nowrap rounded bg-[#238636]/15 px-2 py-0.5 text-[11px] font-medium text-[#3fb950]"
    : "shrink-0 whitespace-nowrap rounded bg-[#30363d]/50 px-2 py-0.5 text-[11px] font-medium text-review-muted";
}

function findingStatusLabel(status) {
  switch (status) {
    case "accepted-comment": return "Staged";
    case "dismissed": return "Dismissed";
    case "accepted-risk": return "Accepted risk";
    default: return "Needs review";
  }
}

function findingStatusClass(status) {
  switch (status) {
    case "accepted-comment": return "text-[#3fb950]";
    case "dismissed": return "text-review-muted";
    case "accepted-risk": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function aiReviewStepClass(status) {
  switch (status) {
    case "running": return "text-[#58a6ff]";
    case "done": return "text-[#3fb950]";
    case "failed": return "text-[#f85149]";
    default: return "text-review-muted";
  }
}

function chapterPriorityOrder(priority) {
  switch (priority) {
    case "review-first": return 0;
    case "high-attention": return 1;
    case "standard": return 2;
    case "low-attention": return 3;
    case "reference": return 4;
    default: return 2;
  }
}

function inferredChapterReviewOrder(chapter) {
  const title = String(chapter?.title || "").toLowerCase();
  if (title.includes("schema") || title.includes("migration")) return 10;
  if (title.includes("api") || title.includes("contract")) return 20;
  if (title.includes("service") || title.includes("behavior")) return 30;
  if (title.includes("model") || title.includes("data")) return 40;
  if (title.includes("test")) return 50;
  if (title.includes("misc") || title.includes("doc") || title.includes("package")) return 90;
  return 60;
}

function chapterReviewOrder(chapter, index, hasExplicitReviewOrder) {
  if (Number.isInteger(chapter?.reviewOrder) && chapter.reviewOrder > 0) return chapter.reviewOrder;
  return hasExplicitReviewOrder ? index + 1 : inferredChapterReviewOrder(chapter);
}

function chapterReviewWeight(chapter) {
  return Number.isFinite(chapter?.reviewWeight) ? chapter.reviewWeight : 0;
}

function isUnmappedReviewChapter(chapter) {
  return chapter?.id === "unmapped-diff" || chapter?.title === "Unmapped diff";
}

function getReviewChapters() {
  const chapters = reviewData.map?.chapters || reviewData.analysis?.chapters || [];
  const hasExplicitReviewOrder = chapters.some((chapter) => Number.isInteger(chapter?.reviewOrder) && chapter.reviewOrder > 0);
  return chapters
    .map((chapter, index) => ({ chapter, index }))
    .sort((left, right) => {
      const leftUnmapped = isUnmappedReviewChapter(left.chapter);
      const rightUnmapped = isUnmappedReviewChapter(right.chapter);
      if (leftUnmapped !== rightUnmapped) return leftUnmapped ? 1 : -1;
      return chapterReviewOrder(left.chapter, left.index, hasExplicitReviewOrder) - chapterReviewOrder(right.chapter, right.index, hasExplicitReviewOrder)
        || chapterPriorityOrder(left.chapter.priority) - chapterPriorityOrder(right.chapter.priority)
        || chapterReviewWeight(right.chapter) - chapterReviewWeight(left.chapter)
        || left.index - right.index;
    })
    .map(({ chapter }) => chapter);
}

function getReviewFindings() {
  return reviewData.analysis?.findings || [];
}

function getReviewFinding(findingId) {
  return getReviewFindings().find((finding) => finding.id === findingId) || null;
}

function getReviewChapter(chapterId) {
  return getReviewChapters().find((chapter) => chapter.id === chapterId) || null;
}

function getFileById(fileId) {
  return reviewData.files.find((file) => file.id === fileId) || null;
}

function isFileReviewed(fileId) {
  const hasVisits = (reviewData.map?.chapters || []).some((chapter) => (chapter.visits || []).some((visit) => visit.fileId === fileId));
  return hasVisits ? isFileReviewComplete(reviewData.map, state.reviewedVisits, fileId) : state.reviewedFiles[fileId] === true;
}

function uniqueFiles(files) {
  const seen = new Set();
  const result = [];
  for (const file of files) {
    if (!file || seen.has(file.id)) continue;
    seen.add(file.id);
    result.push(file);
  }
  return result;
}

function fileReviewProgress(files) {
  const unique = uniqueFiles(files);
  return {
    reviewed: unique.filter((file) => isFileReviewed(file.id)).length,
    total: unique.length,
  };
}

function chapterReviewProgress(chapter) {
  const visits = chapter?.visits || [];
  if (visits.length > 0) {
    return { reviewed: visits.filter((visit) => state.reviewedVisits[visit.id] === true).length, total: visits.length };
  }
  return fileReviewProgress(getChapterDisplayFiles(chapter));
}

function visitsForFile(fileId) {
  return getReviewChapters().flatMap((chapter) => chapter.visits || []).filter((visit) => visit.fileId === fileId);
}

function selectVisitForFile(fileId) {
  const visits = visitsForFile(fileId);
  const preferredChapter = state.activeInsight.type === "chapter" ? getReviewChapter(state.activeInsight.id) : null;
  const preferredVisitIds = new Set((preferredChapter?.visits || []).map((visit) => visit.id));
  const selected = visits.find((visit) => visit.id === state.activeVisitId)
    || visits.find((visit) => preferredVisitIds.has(visit.id) && state.reviewedVisits[visit.id] !== true)
    || visits.find((visit) => preferredVisitIds.has(visit.id))
    || visits.find((visit) => state.reviewedVisits[visit.id] !== true)
    || visits[0]
    || null;
  state.activeVisitId = selected?.id || null;
}

function isChapterReviewed(chapter) {
  const progress = chapterReviewProgress(chapter);
  return progress.total > 0
    ? progress.reviewed >= progress.total
    : state.reviewedChapters[chapter.id] === true;
}

function chapterForFile(fileId) {
  return getReviewChapters().find((chapter) => getChapterDisplayFiles(chapter).some((file) => file.id === fileId)) || null;
}

function chapterDisplayTitle(chapter) {
  const index = getReviewChapters().findIndex((item) => item.id === chapter?.id);
  const prefix = index >= 0 ? `${index + 1}. ` : "";
  return `${prefix}${chapter?.title || "Review area"}`;
}

function chapterFindings(chapter) {
  const findingIds = new Set(chapter?.findingIds || []);
  return getReviewFindings().filter((finding) => findingIds.has(finding.id));
}

function shouldRenderUnifiedForFile(file = activeFile()) {
  const counts = fileDiffstatCounts(file, state.currentScope);
  return activeFileShowsDiff() && (counts?.added || 0) > 0 && (counts?.deleted || 0) === 0;
}

function getOrderedReviewFiles() {
  const scopedFiles = getScopedFiles();
  const scopedFileIds = new Set(scopedFiles.map((file) => file.id));
  const planFiles = getReviewChapters()
    .flatMap((chapter) => getChapterDisplayFiles(chapter))
    .filter((file) => scopedFileIds.has(file.id));
  return uniqueFiles([...planFiles, ...scopedFiles]);
}

function findNextUnreviewedFile(currentFileId) {
  const files = getOrderedReviewFiles();
  if (files.length === 0) return null;
  const currentIndex = files.findIndex((file) => file.id === currentFileId);
  const startIndex = currentIndex >= 0 ? currentIndex : -1;
  const orderedCandidates = [
    ...files.slice(startIndex + 1),
    ...files.slice(0, Math.max(0, startIndex)),
  ];
  return orderedCandidates.find((file) => file.id !== currentFileId && !isFileReviewed(file.id)) || null;
}

function advanceToNextUnreviewedFile(currentFileId) {
  const nextFile = findNextUnreviewedFile(currentFileId);
  if (!nextFile) return false;

  const nextChapter = chapterForFile(nextFile.id);
  if (state.activeSidebarTab === "review-map" && nextChapter) {
    state.activeInsight = { type: "chapter", id: nextChapter.id };
  }
  openFileWithPendingHunk(nextFile.id, 1);
  requestAnimationFrame(() => {
    focusDiffPane();
  });
  return true;
}

function isCommentInScope(comment, scope = state.currentScope) {
  return comment.scope === scope && (comment.scope !== "commit" || comment.commitSha === state.selectedCommitSha);
}

function getDraftComments(scope = state.currentScope) {
  return state.comments.filter((comment) => isCommentInScope(comment, scope) && commentLifecycleState(comment) !== "published");
}

function getDraftCommentsForFile(fileId, scope = state.currentScope) {
  return state.comments.filter((comment) => comment.fileId === fileId && isCommentInScope(comment, scope) && commentLifecycleState(comment) !== "published");
}

function getDraftCommentsForChapter(chapter, scope = state.currentScope) {
  const fileIds = new Set(chapter.fileIds || []);
  return state.comments.filter((comment) => fileIds.has(comment.fileId) && isCommentInScope(comment, scope) && commentLifecycleState(comment) !== "published");
}

function getFindingsForFile(fileId) {
  return getReviewFindings().filter((finding) =>
    (finding.locations || []).some((location) => location.fileId === fileId)
  );
}

function getVisibleFindingsForFile(fileId) {
  return getFindingsForFile(fileId).filter((finding) => {
    const status = state.findingStatuses[finding.id] || "new";
    return status === "new" || status === "accepted-comment";
  });
}

function findingLocationKey(finding, location) {
  return `${finding.id}:${location.fileId}:${location.side}:${location.line ?? "file"}`;
}

function isFindingLocationDismissed(finding, location) {
  return state.dismissedFindingLocationKeys.has(findingLocationKey(finding, location));
}

function getOpenInlineFindingEntriesForFile(file) {
  if (!file || state.currentScope !== "git-diff") return [];
  const comparison = getScopeComparison(file, state.currentScope);
  if (!comparison) return [];
  const entries = [];
  const seen = new Set();

  for (const finding of getReviewFindings()) {
    const status = state.findingStatuses[finding.id] || "new";
    if (status !== "new") continue;
    for (const location of finding.locations || []) {
      if (location.fileId !== file.id || location.line == null || location.side === "file") continue;
      if (isFindingLocationDismissed(finding, location)) continue;
      const ranges = rangesForSide(comparison, location.side);
      if (!clampRangeToCommentable(location.line, location.line, ranges)) continue;
      const key = `${finding.id}:${location.side}:${location.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ finding, location });
    }
  }

  return entries;
}

function findingStatusCounts() {
  return getReviewFindings().reduce((counts, finding) => {
    const status = state.findingStatuses[finding.id] || "new";
    counts.total += 1;
    if (status === "accepted-comment") counts.drafted += 1;
    else if (status === "dismissed" || status === "accepted-risk") counts.dismissed += 1;
    else counts.open += 1;
    return counts;
  }, { total: 0, open: 0, drafted: 0, dismissed: 0 });
}

function aiReviewChapterProgressById() {
  return new Map((state.aiReview.progress?.chapters || []).map((chapter) => [chapter.chapterId, chapter]));
}

function runningAiReviewChapterProgress() {
  return (state.aiReview.progress?.chapters || []).find((chapter) => chapter.status === "running") || null;
}

function aiReviewFileState(fileId) {
  if (state.aiReview.status !== "running") return "idle";
  const progressById = aiReviewChapterProgressById();
  let hasQueued = false;
  for (const chapter of getReviewChapters()) {
    if (!(chapter.fileIds || []).includes(fileId)) continue;
    const progress = progressById.get(chapter.id);
    if (progress?.status === "running") return "running";
    if (progress?.status === "queued") hasQueued = true;
  }
  return hasQueued ? "queued" : "idle";
}

function treeAiReviewState(node) {
  if (node.kind === "file") return aiReviewFileState(node.file.id);
  let hasQueued = false;
  for (const child of node.children.values()) {
    const stateName = treeAiReviewState(child);
    if (stateName === "running") return "running";
    if (stateName === "queued") hasQueued = true;
  }
  return hasQueued ? "queued" : "idle";
}

function aiReviewActiveTargetLabel() {
  const running = runningAiReviewChapterProgress();
  if (!running) return null;
  const chapter = getReviewChapter(running.chapterId);
  const firstFile = chapter ? getChapterDisplayFiles(chapter)[0] : null;
  return firstFile
    ? shortPathName(getScopeDisplayPath(firstFile, "git-diff") || firstFile.path)
    : running.title;
}

function aiReviewStatusSummary() {
  const counts = findingStatusCounts();
  if (["provisional", "mapping"].includes(reviewData.map?.status) || (state.reviewMapProgress && !["done", "failed"].includes(state.reviewMapProgress.phase))) {
    return `✦ ${state.reviewMapProgress?.message || "Preparing review plan..."}`;
  }
  if (state.aiReview.status === "running") {
    if (state.aiReview.progress?.phase === "scout") return "✦ Mapping PR...";
    if (state.aiReview.progress?.phase === "validation") return "✦ Validating findings...";
    if (state.aiReview.progress?.phase === "synthesis") return "✦ Preparing summary...";

    const target = aiReviewActiveTargetLabel();
    const chapters = state.aiReview.progress?.chapters || [];
    const completed = chapters.filter((chapter) => chapter.status === "done" || chapter.status === "failed").length;
    const total = chapters.length;
    if (target && total > 0) return `✦ Scanning ${target} (${Math.min(completed + 1, total)}/${total})`;
    return `✦ ${state.aiReview.message || "Scanning changed hunks..."}`;
  }

  if (state.aiReview.status === "failed") {
    if ((reviewData.analysis?.findings || []).length > 0) {
      return `AI analysis incomplete • ${counts.open} finding${counts.open === 1 ? "" : "s"} • manual review required`;
    }
    return "AI scan failed";
  }
  if (state.aiReview.status === "done" || state.aiReviewCompleted) {
    return `✓ AI analysis complete • ${counts.open} finding${counts.open === 1 ? "" : "s"}`;
  }

  return canSendRendererMessage() ? "✦ AI analysis queued" : "AI analysis ready";
}

function commentLocationLabel(comment) {
  if (comment.side === "file" || comment.startLine == null) return "File comment";
  const side = comment.side === "original" ? "Original" : "Modified";
  const range = comment.endLine != null && comment.endLine !== comment.startLine
    ? `${comment.startLine}-${comment.endLine}`
    : `${comment.startLine}`;
  return `${side} line ${range}`;
}

function commentSummaryHtml(comments, emptyText) {
  const visibleComments = comments.slice(0, 6);
  const hiddenCount = Math.max(0, comments.length - visibleComments.length);
  if (visibleComments.length === 0) {
    return `<div class="text-sm text-review-muted">${escapeHtml(emptyText)}</div>`;
  }
  return `
    <div class="space-y-1">
      ${visibleComments.map((comment) => {
        const file = getFileById(comment.fileId);
        const body = String(comment.body || "").trim();
        const preview = body ? `"${body.replace(/\s+/g, " ").slice(0, 80)}${body.length > 80 ? "..." : ""}"` : "Empty comment";
        return `
          <button data-comment-jump-id="${escapeHtml(comment.id)}" class="block w-full cursor-pointer rounded px-2 py-1.5 text-left text-xs hover:bg-[#161b22]">
            <span class="block truncate text-review-text">${escapeHtml(getScopeDisplayPath(file, comment.scope))} • ${escapeHtml(commentLocationLabel(comment))} • ${escapeHtml(preview)}</span>
          </button>
        `;
      }).join("")}
      ${hiddenCount > 0 ? `<div class="px-2 text-xs text-review-muted">${hiddenCount} more staged comment(s).</div>` : ""}
    </div>
  `;
}

function openDraftCommentFromSummary(commentId) {
  const comment = state.comments.find((item) => item.id === commentId);
  const file = comment ? getFileById(comment.fileId) : null;
  if (!comment || !file) return;

  saveCurrentScrollPosition();
  state.currentScope = comment.scope;
  if (comment.scope === "commit" && comment.commitSha) {
    state.selectedCommitSha = comment.commitSha;
    commitSelectEl.value = comment.commitSha;
  }
  state.activeFileId = file.id;
  if (comment.side === "original" || comment.side === "modified") {
    state.activeDiffSide = comment.side;
    state.activeDiffLine = comment.startLine;
  }
  state.activeInsight = { type: "comment", id: comment.id };
  state.collapsedCommentIds.delete(comment.id);
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(file.id, comment.scope);

  if (comment.side !== "file" && comment.startLine != null) {
    setTimeout(() => focusDiffLine(comment.side, comment.startLine, comment.endLine ?? comment.startLine), 50);
  }
}

function bindCommentSummaryLinks() {
  insightContentEl.querySelectorAll("[data-comment-jump-id]").forEach((button) => {
    button.addEventListener("click", () => openDraftCommentFromSummary(button.getAttribute("data-comment-jump-id")));
  });
}

function getScopedFiles() {
  switch (state.currentScope) {
    case "git-diff":
      return reviewData.files.filter((file) => file.inGitDiff);
    case "last-commit":
      return reviewData.files.filter((file) => file.inLastCommit);
    case "commit":
      return reviewData.files.filter((file) => state.selectedCommitSha && file.commitComparisons?.[state.selectedCommitSha]);
    default:
      return reviewData.files.filter((file) => file.hasWorkingTreeFile);
  }
}

function ensureActiveFileForScope() {
  const scopedFiles = getScopedFiles();
  if (scopedFiles.length === 0) {
    state.activeFileId = null;
    return;
  }
  if (scopedFiles.some((file) => file.id === state.activeFileId)) {
    return;
  }
  state.activeFileId = scopedFiles[0].id;
}

function activeFile() {
  return reviewData.files.find((file) => file.id === state.activeFileId) ?? null;
}

function getScopeComparison(file, scope = state.currentScope) {
  if (!file) return null;
  if (scope === "git-diff") return file.gitDiff;
  if (scope === "last-commit") return file.lastCommit;
  if (scope === "commit") return state.selectedCommitSha ? file.commitComparisons?.[state.selectedCommitSha] ?? null : null;
  return null;
}

function activeComparison() {
  return getScopeComparison(activeFile(), state.currentScope);
}

function activeFileShowsDiff() {
  return activeComparison() != null;
}

function getEditorForSide(side) {
  if (!diffEditor) return null;
  return side === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
}

function getFocusedDiffSide() {
  if (!diffEditor) return state.activeDiffSide;
  if (diffEditor.getOriginalEditor().hasTextFocus()) return "original";
  if (diffEditor.getModifiedEditor().hasTextFocus()) return "modified";
  return state.activeDiffSide;
}

function rangesForSide(comparison, side) {
  if (!comparison) return [];
  return side === "original"
    ? comparison.commentableOriginalLines || []
    : comparison.commentableModifiedLines || [];
}

function clampRangeToCommentable(startLine, endLine, ranges) {
  const start = Math.min(startLine, endLine);
  const end = Math.max(startLine, endLine);
  const containingRange = (ranges || []).find((range) => start >= range.start && end <= range.end);
  if (!containingRange) return null;
  return { startLine: start, endLine: end };
}

function getReviewableRangesForFile(file = activeFile()) {
  const comparison = getScopeComparison(file, state.currentScope);
  if (!comparison) return [];

  const modified = rangesForSide(comparison, "modified").map((range) => ({ ...range, side: "modified" }));
  const original = rangesForSide(comparison, "original").map((range) => ({ ...range, side: "original" }));
  const primary = modified.length > 0 ? modified : original;
  return primary.sort((a, b) => a.start - b.start);
}

function updateKeyboardLineDecoration(side, startLine, endLine = startLine) {
  if (!diffEditor || !monacoApi || startLine == null) return;
  state.activeDiffSide = side;
  state.activeDiffLine = startLine;
  const decoration = {
    range: new monacoApi.Range(startLine, 1, endLine, 1),
    options: { isWholeLine: true, className: "review-keyboard-line" },
  };

  if (side === "original") {
    originalKeyboardDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalKeyboardDecorations, [decoration]);
    modifiedKeyboardDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedKeyboardDecorations, []);
  } else {
    modifiedKeyboardDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedKeyboardDecorations, [decoration]);
    originalKeyboardDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalKeyboardDecorations, []);
  }

  updateFocusedInlineFinding(side, startLine);
}

function focusDiffLine(side, line, endLine = line) {
  const editor = getEditorForSide(side);
  if (!editor || line == null) return false;
  state.activeDiffSide = side;
  state.activeDiffLine = line;
  editor.focus();
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.revealLineInCenter(line);
  updateKeyboardLineDecoration(side, line, endLine);
  return true;
}

function getCurrentDiffPosition() {
  const side = getFocusedDiffSide();
  const editor = getEditorForSide(side);
  const position = editor?.getPosition();
  return {
    side,
    line: position?.lineNumber || state.activeDiffLine || null,
  };
}

function getScopeFilePath(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.newPath || comparison?.oldPath || file?.path || "";
}

function getScopeDisplayPath(file, scope = state.currentScope) {
  const comparison = getScopeComparison(file, scope);
  return comparison?.displayPath || file?.path || "";
}

function getFileSearchPath(file) {
  return file?.path || "";
}

function getBaseName(path) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function getActiveStatus(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.status ?? file?.worktreeStatus ?? null;
}

function normalizeQuery(query) {
  return String(query || "").trim().toLowerCase().replace(/\s+/g, "");
}

function scoreSubsequence(query, candidate) {
  if (!query) return 0;
  let queryIndex = 0;
  let score = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -2;

  for (let i = 0; i < candidate.length && queryIndex < query.length; i += 1) {
    if (candidate[i] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = i;
    score += 10;

    if (i === previousMatchIndex + 1) {
      score += 8;
    }

    const previousChar = i > 0 ? candidate[i - 1] : "";
    if (i === 0 || previousChar === "/" || previousChar === "_" || previousChar === "-" || previousChar === ".") {
      score += 12;
    }

    previousMatchIndex = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return -1;
  if (firstMatchIndex >= 0) score += Math.max(0, 20 - firstMatchIndex);
  return score;
}

function getFileSearchScore(query, file) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return 0;

  const path = getFileSearchPath(file).toLowerCase();
  const baseName = getBaseName(path);
  const pathScore = scoreSubsequence(normalizedQuery, path);
  const baseScore = scoreSubsequence(normalizedQuery, baseName);
  let score = Math.max(pathScore, baseScore >= 0 ? baseScore + 40 : -1);

  if (score < 0) return -1;
  if (baseName === normalizedQuery) score += 200;
  else if (baseName.startsWith(normalizedQuery)) score += 120;
  else if (path.includes(normalizedQuery)) score += 35;

  return score;
}

function getFilteredFiles() {
  const scopedFiles = getScopedFiles();
  const query = state.fileFilter.trim();
  if (!query) return [...scopedFiles];

  return scopedFiles
    .map((file) => ({ file, score: getFileSearchScore(query, file) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return getFileSearchPath(a.file).localeCompare(getFileSearchPath(b.file));
    })
    .map((entry) => entry.file);
}

function buildTree(files) {
  const root = { name: "", path: "", kind: "dir", children: new Map(), file: null };
  for (const file of files) {
    const path = getFileSearchPath(file);
    const parts = path.split("/");
    let node = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: new Map(),
          file: isLeaf ? file : null,
        });
      }
      node = node.children.get(part);
      if (isLeaf) node.file = file;
    }
  }
  return root;
}

function scopeInstanceKey(scope) {
  return scope === "commit" ? `${scope}:${state.selectedCommitSha || ""}` : scope;
}

function cacheKey(scope, fileId) {
  return `${scopeInstanceKey(scope)}:${fileId}`;
}

function scrollKey(scope, fileId) {
  return `${scopeInstanceKey(scope)}:${fileId}`;
}

function saveCurrentScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  state.scrollPositions[scrollKey(state.currentScope, state.activeFileId)] = {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreFileScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const scrollState = state.scrollPositions[scrollKey(state.currentScope, state.activeFileId)];
  if (!scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function captureScrollState() {
  if (!diffEditor) return null;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  return {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreScrollState(scrollState) {
  if (!diffEditor || !scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function getRequestState(fileId, scope = state.currentScope) {
  const key = cacheKey(scope, fileId);
  return {
    contents: state.fileContents[key],
    error: state.fileErrors[key],
    requestId: state.pendingRequestIds[key],
  };
}

function ensureFileLoaded(fileId, scope = state.currentScope) {
  if (!fileId) return;
  const key = cacheKey(scope, fileId);
  if (state.fileContents[key] != null) return;
  if (state.fileErrors[key] != null) return;
  if (state.pendingRequestIds[key] != null) return;

  const requestId = `request:${Date.now()}:${++requestSequence}`;
  state.pendingRequestIds[key] = requestId;
  renderTree();
  if (canSendRendererMessage()) {
    sendRendererMessage({ type: "request-file", requestId, fileId, scope, commitSha: scope === "commit" ? state.selectedCommitSha : undefined });
  }
}

function openFile(fileId) {
  const alreadyOpen = isFileCanvasActive(state.activeCanvas, state.activeFileId, fileId);
  state.activeCanvas = "file";
  selectVisitForFile(fileId);
  if (state.activeInsight.type === "chapter") {
    state.activeInsight = { type: "default", id: null };
  }
  if (alreadyOpen) {
    ensureFileLoaded(fileId, state.currentScope);
    requestAnimationFrame(applyPendingHunkFocus);
    return;
  }
  saveCurrentScrollPosition();
  state.activeFileId = fileId;
  state.activeDiffLine = null;
  state.activeDiffSide = "modified";
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(fileId, state.currentScope);
}

function openChapterBrief(chapterId) {
  const chapter = getReviewChapter(chapterId);
  if (!chapter) return false;
  state.activeCanvas = "chapter";
  state.activeSidebarTab = "review-map";
  state.activeInsight = { type: "chapter", id: chapter.id };
  saveCurrentScrollPosition();
  renderAll({ restoreFileScroll: false });
  return true;
}

function openFileWithPendingHunk(fileId, direction = 1) {
  state.pendingHunkFocus = { fileId, direction };
  openFile(fileId);
}

function getCurrentChapterIndex() {
  const chapters = getReviewChapters();
  if (chapters.length === 0) return -1;
  if (state.activeInsight.type === "chapter") {
    const index = chapters.findIndex((chapter) => chapter.id === state.activeInsight.id);
    if (index >= 0) return index;
  }
  if (state.activeFileId) {
    const index = chapters.findIndex((chapter) => (chapter.fileIds || []).includes(state.activeFileId));
    if (index >= 0) return index;
  }
  return 0;
}

function openChapterByIndex(index) {
  const chapters = getReviewChapters();
  if (chapters.length === 0) return false;
  const boundedIndex = Math.max(0, Math.min(chapters.length - 1, index));
  const chapter = chapters[boundedIndex];
  if (!chapter) return false;
  state.activeSidebarTab = "review-map";
  state.activeInsight = { type: "chapter", id: chapter.id };
  const fileId = firstExistingChapterFileId(chapter);
  if (fileId) {
    openFileWithPendingHunk(fileId, 1);
  } else {
    renderAll({ restoreFileScroll: false });
  }
  return true;
}

function moveChapter(direction) {
  const index = getCurrentChapterIndex();
  if (index < 0) return false;
  return openChapterByIndex(index + direction);
}

function getKeyboardFileList() {
  if (state.activeInsight.type === "chapter") {
    const chapter = getReviewChapter(state.activeInsight.id);
    const files = chapter ? getChapterDisplayFiles(chapter) : [];
    if (files.length > 0) return files;
  }
  const filteredFiles = getFilteredFiles();
  return filteredFiles.length > 0 ? filteredFiles : getScopedFiles();
}

function moveFile(direction) {
  const files = getKeyboardFileList();
  if (files.length === 0) return false;
  const foundIndex = files.findIndex((file) => file.id === state.activeFileId);
  const currentIndex = foundIndex >= 0 ? foundIndex : direction > 0 ? -1 : files.length;
  const nextIndex = Math.max(0, Math.min(files.length - 1, currentIndex + direction));
  const nextFile = files[nextIndex];
  if (!nextFile) return false;
  openFileWithPendingHunk(nextFile.id, direction >= 0 ? 1 : -1);
  return true;
}

function moveToAdjacentReviewFile(direction) {
  const files = getKeyboardFileList().filter((file) => getReviewableRangesForFile(file).length > 0);
  if (files.length === 0) return false;
  const currentIndex = files.findIndex((file) => file.id === state.activeFileId);
  const fallbackIndex = direction > 0 ? -1 : files.length;
  const nextIndex = Math.max(0, Math.min(files.length - 1, (currentIndex >= 0 ? currentIndex : fallbackIndex) + direction));
  const nextFile = files[nextIndex];
  if (!nextFile || nextFile.id === state.activeFileId) return false;
  openFileWithPendingHunk(nextFile.id, direction);
  return true;
}

function focusHunk(direction) {
  const file = activeFile();
  const ranges = getReviewableRangesForFile(file);
  if (ranges.length === 0) return moveToAdjacentReviewFile(direction);

  const current = getCurrentDiffPosition();
  const sameSideRanges = ranges.filter((range) => range.side === current.side);
  const candidateRanges = sameSideRanges.length > 0 ? sameSideRanges : ranges;
  const currentLine = current.line ?? (direction > 0 ? 0 : Number.POSITIVE_INFINITY);
  const target = direction > 0
    ? candidateRanges.find((range) => range.start > currentLine) || null
    : [...candidateRanges].reverse().find((range) => range.start < currentLine) || null;

  if (target) {
    focusDiffLine(target.side, target.start, target.end);
    return true;
  }

  return moveToAdjacentReviewFile(direction);
}

function moveDiffFocus(direction) {
  if (!diffEditor) return false;
  const editor = diffEditor.getModifiedEditor().hasTextFocus()
    ? diffEditor.getModifiedEditor()
    : diffEditor.getOriginalEditor().hasTextFocus()
      ? diffEditor.getOriginalEditor()
      : diffEditor.getModifiedEditor();
  const side = editor === diffEditor.getOriginalEditor() ? "original" : "modified";
  const model = editor.getModel();
  if (!model) return false;
  const visibleRange = editor.getVisibleRanges?.()[0] || null;
  const currentLine = editor.getPosition()?.lineNumber
    || state.activeDiffLine
    || visibleRange?.startLineNumber
    || 1;
  const targetLine = Math.max(1, Math.min(model.getLineCount(), currentLine + direction));
  editor.focus();
  editor.setPosition({ lineNumber: targetLine, column: 1 });
  if (typeof editor.revealLineInCenterIfOutsideViewport === "function") {
    editor.revealLineInCenterIfOutsideViewport(targetLine);
  } else {
    editor.revealLineInCenter(targetLine);
  }
  updateKeyboardLineDecoration(side, targetLine);
  return true;
}

function getCurrentInlineFindingEntry() {
  const entries = getInlineAiFindingEntries(activeFile());
  if (entries.length === 0) return null;
  if (state.activeInsight.type === "finding") {
    const active = entries.find((entry) => entry.finding.id === state.activeInsight.id);
    if (active) return active;
  }

  const current = getCurrentDiffPosition();
  const sameSide = entries.filter((entry) => entry.location.side === current.side);
  const candidates = sameSide.length > 0 ? sameSide : entries;
  const currentLine = current.line ?? 0;
  return candidates
    .filter((entry) => entry.location.line >= currentLine)
    .sort((left, right) => left.location.line - right.location.line)[0]
    ?? candidates.sort((left, right) => left.location.line - right.location.line)[0]
    ?? null;
}

function stageCurrentFinding() {
  const entry = getCurrentInlineFindingEntry();
  if (!entry) return false;
  state.activeInsight = { type: "finding", id: entry.finding.id };
  createDraftCommentFromFinding(entry.finding, entry.location);
  return true;
}

function dismissCurrentFinding() {
  const entry = getCurrentInlineFindingEntry();
  if (!entry) return false;
  dismissFindingLocation(entry.finding, entry.location);
  return true;
}

function editActiveComment() {
  if (state.activeInsight.type !== "comment") return false;
  const comment = state.comments.find((item) => item.id === state.activeInsight.id);
  if (!comment) return false;
  enterCommentEdit(comment);
  return true;
}

function applyPendingHunkFocus() {
  const pending = state.pendingHunkFocus;
  if (!pending || pending.fileId !== state.activeFileId) return;
  const ranges = getReviewableRangesForFile(activeFile());
  if (ranges.length === 0) {
    state.pendingHunkFocus = null;
    return;
  }
  const target = pending.direction < 0 ? ranges[ranges.length - 1] : ranges[0];
  state.pendingHunkFocus = null;
  if (target) focusDiffLine(target.side, target.start, target.end);
}

function pulseInlineFinding(findingId, location) {
  if (!findingId || !location) return;
  document.querySelectorAll(".ai-finding-zone").forEach((node) => {
    if (node.dataset.aiFindingId !== findingId) return;
    if (node.dataset.aiFindingSide !== location.side) return;
    if (Number(node.dataset.aiFindingLine) !== Number(location.line)) return;
    node.classList.remove("is-pulsing");
    void node.offsetWidth;
    node.classList.add("is-pulsing");
    setTimeout(() => node.classList.remove("is-pulsing"), 1300);
  });
}

function isAiFindingExpanded(findingId) {
  return getReviewFinding(findingId) != null
    && (state.findingStatuses[findingId] || "new") === "new"
    && isDisclosureExpanded(state.collapsedFindingIds, findingId);
}

function isAiFindingActive(findingId) {
  return state.activeInsight.type === "finding" && state.activeInsight.id === findingId;
}

function findInlineFindingAtLine(side, line) {
  return getInlineAiFindingEntries(activeFile())
    .find((entry) => entry.location.side === side && Number(entry.location.line) === Number(line)) || null;
}

function updateFocusedInlineFinding(side, line) {
  const activeFindingId = state.activeInsight.type === "finding" ? state.activeInsight.id : null;
  const entry = findInlineFindingAtLine(side, line);
  const nextFindingId = entry?.finding.id || null;
  if (activeFindingId === nextFindingId) return;

  if (nextFindingId) {
    state.activeInsight = { type: "finding", id: nextFindingId };
  } else if (activeFindingId) {
    state.activeInsight = { type: "default", id: null };
  } else {
    return;
  }

  syncViewZones();
  updateDecorations();
  renderTree();
  if (entry) requestAnimationFrame(() => pulseInlineFinding(entry.finding.id, entry.location));
}

function toggleInlineFinding(entry) {
  if (!entry) return false;

  toggleDisclosure(state.collapsedFindingIds, entry.finding.id);
  const expanded = isAiFindingExpanded(entry.finding.id);
  state.activeInsight = expanded ? { type: "finding", id: entry.finding.id } : { type: "default", id: null };
  syncViewZones();
  updateDecorations();
  renderTree();
  focusDiffLine(side, line, line);
  if (expanded) requestAnimationFrame(() => pulseInlineFinding(entry.finding.id, entry.location));
  return true;
}

function toggleInlineFindingAtLine(side, line) {
  return toggleInlineFinding(findInlineFindingAtLine(side, line));
}

function queueFindingFocus(location, findingId = null) {
  state.pendingHunkFocus = null;
  if (!location || location.side === "file" || location.line == null) {
    state.pendingFindingFocus = null;
    return;
  }
  state.pendingFindingFocus = {
    findingId,
    fileId: location.fileId,
    scope: "git-diff",
    side: location.side,
    line: location.line,
    endLine: location.line,
  };
}

function applyPendingFindingFocus() {
  const pending = state.pendingFindingFocus;
  if (!pending) return false;
  if (pending.fileId !== state.activeFileId || pending.scope !== state.currentScope) return false;
  if (!isActiveFileReady()) return false;

  const focused = focusDiffLine(pending.side, pending.line, pending.endLine);
  if (!focused) return false;
  state.pendingFindingFocus = null;
  if (pending.findingId) expandDisclosure(state.collapsedFindingIds, pending.findingId);
  syncViewZones();
  updateDecorations();
  pulseInlineFinding(pending.findingId, pending);
  return true;
}

function treeReviewProgress(node) {
  if (node.kind === "file") {
    return {
      reviewed: isFileReviewed(node.file.id) ? 1 : 0,
      total: 1,
    };
  }

  return [...node.children.values()].reduce((progress, child) => {
    const childProgress = treeReviewProgress(child);
    progress.reviewed += childProgress.reviewed;
    progress.total += childProgress.total;
    return progress;
  }, { reviewed: 0, total: 0 });
}

function treeContainsFile(node, fileId) {
  if (!fileId) return false;
  if (node.kind === "file") return node.file.id === fileId;
  return [...node.children.values()].some((child) => treeContainsFile(child, fileId));
}

function compactDirectoryNode(node) {
  let compactNode = node;
  const pathParts = [node.name];

  while (compactNode.kind === "dir" && compactNode.children.size === 1) {
    const onlyChild = [...compactNode.children.values()][0];
    if (!onlyChild || onlyChild.kind !== "dir") break;
    compactNode = onlyChild;
    pathParts.push(onlyChild.name);
  }

  return {
    node: compactNode,
    name: pathParts.join("/"),
  };
}

function fileNavIconHtml(file, options = {}) {
  const requestState = getRequestState(file.id, state.currentScope);
  const reviewed = isFileReviewed(file.id);
  const loading = requestState.requestId != null && requestState.contents == null;
  const errored = requestState.error != null;
  const aiState = aiReviewFileState(file.id);

  if (aiState === "running") {
    return `<span class="sidebar-scanning-icon mt-0.5 shrink-0" title="AI is scanning this file"></span>`;
  }

  const mutedClass = options.active ? "text-[#c9d1d9]" : "text-review-muted";
  if (reviewed) return `<span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[12px] text-[#3fb950]">✓</span>`;
  if (errored) return `<span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[12px] text-red-400">!</span>`;
  if (loading || aiState === "queued") return `<span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[12px] text-[#58a6ff]">…</span>`;
  return `
    <svg aria-hidden="true" class="mt-0.5 h-3.5 w-3.5 shrink-0 ${mutedClass}" viewBox="0 0 16 16" fill="none">
      <path d="M4.25 2.75h5.1l2.4 2.4v8.1h-7.5V2.75Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"></path>
      <path d="M9.25 2.95V5.4h2.35" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

function fileNavBadgesHtml(file) {
  const findingCount = getOpenInlineFindingEntriesForFile(file).length;
  const commentCount = getDraftCommentsForFile(file.id).length;
  const stats = diffstatHtml(fileDiffstatCounts(file), { compact: true, blocks: 0 });
  return `
    ${stats}
    ${findingCount > 0 ? `<button type="button" data-finding-file-id="${escapeHtml(file.id)}" class="shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold text-[#d2a8ff] hover:bg-[#8957e5]/12 focus:outline-none focus:ring-1 focus:ring-[#8957e5]/50" title="Jump to first inline AI review item in this file">● ${findingCount}</button>` : ""}
    ${commentCount > 0 ? `<span class="shrink-0 rounded-full bg-[#238636]/14 px-1.5 py-0.5 text-[10px] font-semibold text-[#7ee787]" title="${commentCount} staged comment${commentCount === 1 ? "" : "s"}">✓ ${commentCount}</span>` : ""}
  `;
}

function fileDisplayParts(file, label) {
  const displayPath = String(label || getScopeDisplayPath(file, state.currentScope) || file.path || "");
  const parts = displayPath.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return { filename: displayPath || "Untitled file", directory: "" };
  }
  const filename = parts[parts.length - 1];
  const directory = `${parts.slice(0, -1).join("/")}/`;
  return { filename, directory };
}

function openFirstVisibleFindingForFile(fileId) {
  const file = reviewData.files.find((candidate) => candidate.id === fileId) || null;
  const entry = getOpenInlineFindingEntriesForFile(file)[0];
  if (!entry) return false;
  openFindingLocation(entry.finding, entry.location);
  return true;
}

function bindFindingBadgeActions(container) {
  container.querySelectorAll("[data-finding-file-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFirstVisibleFindingForFile(button.getAttribute("data-finding-file-id"));
    });
  });
}

function renderFileRow(file, options = {}) {
  const reviewed = isFileReviewed(file.id);
  const active = isFileCanvasActive(state.activeCanvas, state.activeFileId, file.id);
  const label = options.label || getScopeDisplayPath(file, state.currentScope) || file.path;
  const display = fileDisplayParts(file, label);
  const row = document.createElement("div");
  row.title = label;
  row.className = [
    "group flex w-full items-start justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px]",
    active ? "bg-[#373e47] text-white" : reviewed ? "text-[#c9d1d9] hover:bg-[#21262d]" : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]",
  ].join(" ");
  row.style.paddingLeft = `${options.indentPx ?? 24}px`;
  row.innerHTML = `
    <button type="button" class="flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 text-left ${active ? "font-medium" : ""}" ${active ? "aria-current=\"true\"" : ""}>
      ${fileNavIconHtml(file, { active })}
      <span class="min-w-0 flex-1">
        <span class="block truncate ${reviewed ? "line-through opacity-60" : ""}">${escapeHtml(display.filename)}</span>
        ${display.directory ? `<span class="mt-0.5 block truncate text-[11px] font-normal text-review-muted/80">${escapeHtml(display.directory)}</span>` : ""}
      </span>
    </button>
    <span class="flex w-[78px] shrink-0 items-center justify-end gap-1.5 pt-0.5">
      ${fileNavBadgesHtml(file)}
    </span>
  `;
  row.querySelector("button")?.addEventListener("click", () => openFile(file.id));
  bindFindingBadgeActions(row);
  fileTreeEl.appendChild(row);
}

function getReviewNavigationGroups(files) {
  const scopedFileIds = new Set(files.map((file) => file.id));
  const assignedIds = new Set();
  const groups = [];

  getReviewChapters().forEach((chapter, index) => {
    const chapterFiles = uniqueFiles(getChapterFiles(chapter).filter((file) => scopedFileIds.has(file.id)));
    if (chapterFiles.length === 0) return;
    chapterFiles.forEach((file) => assignedIds.add(file.id));
    groups.push({
      id: `chapter:${chapter.id}`,
      title: `${groups.length + 1}. ${chapter.title}`,
      chapter,
      files: chapterFiles,
      order: index,
    });
  });

  const remainingFiles = files.filter((file) => !assignedIds.has(file.id));
  if (remainingFiles.length > 0) {
    groups.push({
      id: "chapter:other-changes",
      title: "Other changes",
      chapter: null,
      files: remainingFiles,
      order: groups.length,
    });
  }

  return groups;
}

function renderReviewGroup(group) {
  const progress = fileReviewProgress(group.files);
  const complete = progress.total > 0 && progress.reviewed >= progress.total;
  const activeFileInGroup = group.files.some((file) => isFileCanvasActive(state.activeCanvas, state.activeFileId, file.id));
  const active = (state.activeCanvas === "chapter" && state.activeInsight.type === "chapter" && state.activeInsight.id === group.chapter?.id) || activeFileInGroup;
  if (complete && state.collapsedDirs[group.id] == null && !active) {
    state.collapsedDirs[group.id] = true;
  }
  const collapsed = state.collapsedDirs[group.id] === true;
  const running = group.files.some((file) => aiReviewFileState(file.id) === "running");
  const row = document.createElement("div");
  row.className = [
    "group flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left text-[13px] hover:bg-[#21262d]",
    active ? "bg-[#161b22] text-white" : complete ? "text-review-muted" : "text-[#c9d1d9]",
  ].join(" ");
  row.innerHTML = `
    <button type="button" data-chapter-toggle="${escapeHtml(group.id)}" class="mt-0.5 shrink-0 cursor-pointer rounded text-[#8b949e] hover:text-review-text" title="${collapsed ? "Expand" : "Collapse"} ${escapeHtml(group.title)}">
      <svg class="h-4 w-4 transition-transform ${collapsed ? "-rotate-90" : ""}" viewBox="0 0 16 16" fill="currentColor">
        <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
      </svg>
    </button>
    <span class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      ${running
        ? `<span class="sidebar-scanning-icon" title="AI is scanning this review area"></span>`
        : complete ? `<span class="text-[12px] text-[#3fb950]">✓</span>` : ""}
    </span>
    <button type="button" data-chapter-open="${escapeHtml(group.chapter?.id || "")}" class="min-w-0 flex-1 cursor-pointer text-left font-medium leading-tight ${complete ? "line-through opacity-70" : ""}">${escapeHtml(group.title)}</button>
    <span class="mt-0.5 shrink-0 text-[11px] text-review-muted">${progress.reviewed}/${progress.total}${complete ? " ✓" : ""}</span>
  `;
  row.querySelector("[data-chapter-toggle]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.collapsedDirs[group.id] = !collapsed;
    renderTree();
  });
  row.querySelector("[data-chapter-open]")?.addEventListener("click", () => {
    if (group.chapter) openChapterBrief(group.chapter.id);
  });
  fileTreeEl.appendChild(row);

  if (!collapsed) {
    group.files.forEach((file) => {
      renderFileRow(file, {
        label: getScopeDisplayPath(file, state.currentScope) || file.path,
        indentPx: 25,
      });
    });
  }
}

function renderReviewPlanTree(files) {
  const groups = getReviewNavigationGroups(files);
  if (groups.length === 0) {
    renderTreeNode(buildTree(files), 0);
    return;
  }
  groups.forEach(renderReviewGroup);
}

function renderTreeNode(node, depth) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const indentPx = 12;

  for (const child of children) {
    if (child.kind === "dir") {
      const compact = compactDirectoryNode(child);
      const compactChild = compact.node;
      const progress = treeReviewProgress(compactChild);
      const complete = progress.total > 0 && progress.reviewed >= progress.total;
      if (complete && state.collapsedDirs[compactChild.path] == null && !treeContainsFile(compactChild, state.activeFileId)) {
        state.collapsedDirs[compactChild.path] = true;
      }
      const collapsed = state.collapsedDirs[compactChild.path] === true;
      const aiState = treeAiReviewState(compactChild);
      const row = document.createElement("button");
      row.type = "button";
      row.className = [
        "group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] hover:bg-[#21262d]",
        complete ? "text-review-muted" : "text-[#c9d1d9]",
      ].join(" ");
      row.style.paddingLeft = `${depth * indentPx + 8}px`;
      row.innerHTML = `
        <svg class="h-4 w-4 shrink-0 text-[#8b949e] transition-transform ${collapsed ? "-rotate-90" : ""}" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
        </svg>
        <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          ${aiState === "running"
            ? `<span class="sidebar-scanning-icon" title="AI is scanning this area"></span>`
            : complete ? `<span class="text-[12px] text-[#3fb950]">✓</span>` : ""}
        </span>
        <span class="min-w-0 flex-1 truncate ${complete ? "opacity-70" : ""}">${escapeHtml(compact.name)}</span>
        <span class="shrink-0 text-[11px] text-review-muted">${progress.reviewed}/${progress.total}</span>
      `;
      row.addEventListener("click", () => {
        state.collapsedDirs[compactChild.path] = !collapsed;
        renderTree();
      });
      fileTreeEl.appendChild(row);
      if (!collapsed) renderTreeNode(compactChild, depth + 1);
      continue;
    }

    renderFileRow(child.file, {
      label: child.name,
      indentPx: (depth * indentPx) + 26,
    });
  }
}

function renderSearchResults(files) {
  files.forEach((file) => {
    const path = getFileSearchPath(file);
    renderFileRow(file, {
      label: path,
      indentPx: 8,
    });
  });
}

function updateSidebarLayout() {
  const collapsed = state.sidebarCollapsed;
  sidebarEl.style.width = collapsed ? "0px" : "280px";
  sidebarEl.style.minWidth = collapsed ? "0px" : "280px";
  sidebarEl.style.flexBasis = collapsed ? "0px" : "280px";
  sidebarEl.style.borderRightWidth = collapsed ? "0px" : "1px";
  sidebarEl.style.pointerEvents = collapsed ? "none" : "auto";
  toggleSidebarButton.textContent = collapsed ? "Show plan" : "Review plan";
}

function setSidebarTab(tab) {
  state.activeSidebarTab = tab;
  renderAll({ restoreFileScroll: false });
}

function updateSidebarTabs() {
  // The sidebar is a single navigation tree. These legacy tab buttons remain hidden
  // in the DOM only to avoid breaking older sessions that restore tab state.
}

function updateFilterPlaceholder() {
  const count = getScopedFiles().length;
  const noun = count === 1 ? "file" : "files";
  sidebarSearchInputEl.placeholder = state.currentScope === "all-files"
    ? `Filter ${count} ${noun}...`
    : `Filter ${count} changed ${noun}...`;
  sidebarSearchInputEl.setAttribute("aria-label", sidebarSearchInputEl.placeholder.replace("...", ""));
}

function updateScopeButtons() {
  scopeControlsEl.className = "hidden";
  scopeControlsEl.setAttribute("aria-hidden", "true");
  commitSelectEl.className = "hidden";
  commitSelectEl.setAttribute("aria-hidden", "true");
  commitSelectEl.tabIndex = -1;
  updateFilterPlaceholder();

  const counts = {
    diff: reviewData.files.filter((file) => file.inGitDiff).length,
    lastCommit: reviewData.files.filter((file) => file.inLastCommit).length,
    commit: state.selectedCommitSha ? reviewData.files.filter((file) => file.commitComparisons?.[state.selectedCommitSha]).length : 0,
    all: reviewData.files.filter((file) => file.hasWorkingTreeFile).length,
  };

  const applyButtonClasses = (button, active, disabled) => {
    button.disabled = disabled;
    button.className = disabled
      ? "cursor-default rounded-md border border-review-border bg-[#11161d] px-2.5 py-1 text-[11px] font-medium text-review-muted opacity-60"
      : active
        ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-2.5 py-1 text-[11px] font-medium text-[#3fb950] hover:bg-[#238636]/25"
        : "cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-[11px] font-medium text-review-text hover:bg-[#21262d]";
  };

  scopeDiffButton.textContent = `Git diff${counts.diff > 0 ? ` (${counts.diff})` : ""}`;
  scopeLastCommitButton.textContent = `Last commit${counts.lastCommit > 0 ? ` (${counts.lastCommit})` : ""}`;
  scopeCommitButton.textContent = `Commits${counts.commit > 0 ? ` (${counts.commit})` : ""}`;
  scopeAllButton.textContent = `All files${counts.all > 0 ? ` (${counts.all})` : ""}`;

  applyButtonClasses(scopeDiffButton, state.currentScope === "git-diff", counts.diff === 0);
  applyButtonClasses(scopeLastCommitButton, state.currentScope === "last-commit", counts.lastCommit === 0);
  applyButtonClasses(scopeCommitButton, state.currentScope === "commit", !state.selectedCommitSha || counts.commit === 0);
  applyButtonClasses(scopeAllButton, state.currentScope === "all-files", counts.all === 0);
}

function updateAiReviewButton() {
  const running = state.aiReview.status === "running";
  document.querySelectorAll("[data-action='run-ai-review']").forEach((button) => {
    button.disabled = running;
    button.textContent = running ? "..." : "Refresh";
    button.title = "Refresh AI analysis";
    button.className = running
      ? "shrink-0 cursor-default rounded px-2 py-1 text-[11px] font-medium text-review-muted opacity-70"
      : "shrink-0 cursor-pointer rounded px-2 py-1 text-[11px] font-medium text-review-muted hover:bg-[#21262d] hover:text-review-text";
  });
}

function toolbarButtonClass(active = false) {
  return active
    ? "cursor-pointer rounded-md border border-[#2ea043]/50 bg-[#238636] px-3 py-1 text-xs font-medium text-white hover:bg-[#2ea043]"
    : "cursor-pointer rounded-md border border-transparent bg-transparent px-3 py-1 text-xs font-medium text-review-text hover:bg-[#21262d]";
}

function updateToggleButtons() {
  if (state.activeCanvas === "chapter") {
    toggleWrapButton.style.display = "none";
    toggleUnchangedButton.style.display = "none";
    fileCommentButton.style.display = "none";
    toggleReviewedButton.style.display = "none";
    updateScopeButtons();
    updateAiReviewButton();
    submitButton.disabled = false;
    return;
  }
  const file = activeFile();
  const reviewed = file ? isFileReviewed(file.id) : false;
  toggleWrapButton.style.display = "inline-flex";
  fileCommentButton.style.display = "inline-flex";
  toggleReviewedButton.style.display = "inline-flex";
  toggleReviewedButton.setAttribute("aria-pressed", reviewed ? "true" : "false");
  toggleReviewedButton.title = reviewed ? "Mark this file not reviewed" : "Mark this file reviewed and advance";
  toggleReviewedButton.innerHTML = reviewed ? `<span class="mr-1">✓</span><span>Reviewed</span>` : "<span>Reviewed</span>";
  toggleReviewedButton.className = toolbarButtonClass(reviewed);
  toggleWrapButton.textContent = state.wrapLines ? "Wrap lines" : "No wrap";
  toggleWrapButton.className = toolbarButtonClass(false);
  toggleUnchangedButton.textContent = state.hideUnchanged ? "Full file" : "Changed areas";
  toggleUnchangedButton.className = toolbarButtonClass(false);
  toggleUnchangedButton.style.display = activeFileShowsDiff() ? "inline-flex" : "none";
  fileCommentButton.className = toolbarButtonClass(false);
  updateScopeButtons();
  updateAiReviewButton();
  modeHintEl.textContent = scopeHint(state.currentScope);
  submitButton.disabled = false;
}

function findPreferredScopeForFile(file) {
  if (getScopedFiles().some((scopedFile) => scopedFile.id === file.id)) {
    return { scope: state.currentScope, commitSha: state.selectedCommitSha };
  }
  if (file.inGitDiff) return { scope: "git-diff", commitSha: state.selectedCommitSha };
  if (file.inLastCommit) return { scope: "last-commit", commitSha: state.selectedCommitSha };
  if (file.hasWorkingTreeFile) return { scope: "all-files", commitSha: state.selectedCommitSha };

  const commitSha = Object.keys(file.commitComparisons || {})[0];
  if (commitSha) return { scope: "commit", commitSha };
  return { scope: state.currentScope, commitSha: state.selectedCommitSha };
}

function openFileFromAnalysis(fileId) {
  const file = getFileById(fileId);
  if (!file) return;

  saveCurrentScrollPosition();
  state.activeCanvas = "file";
  const preferred = findPreferredScopeForFile(file);
  state.currentScope = preferred.scope;
  if (preferred.scope === "commit" && preferred.commitSha) {
    state.selectedCommitSha = preferred.commitSha;
    commitSelectEl.value = preferred.commitSha;
  }
  state.activeFileId = file.id;
  selectVisitForFile(file.id);
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(file.id, state.currentScope);
}

function firstExistingChapterFileId(chapter) {
  const files = getChapterDisplayFiles(chapter);
  return files.find((file) => !isFileReviewed(file.id))?.id ?? files[0]?.id ?? null;
}

function firstDraftableFindingLocation(finding) {
  for (const location of finding.locations || []) {
    if (location.line == null || location.side === "file") continue;
    const file = getFileById(location.fileId);
    const comparison = file?.gitDiff;
    if (!comparison) continue;
    const range = clampRangeToCommentable(location.line, location.line, rangesForSide(comparison, location.side));
    if (range) return location;
  }
  return null;
}

function firstLocationLabel(finding) {
  const location = (finding.locations || [])[0];
  if (!location) return "No location";
  return `${location.path}${location.line != null ? `:${location.line}` : ""}`;
}

function getChapterFiles(chapter) {
  return (chapter.fileIds || []).map(getFileById).filter(Boolean);
}

function getChapterDisplayFiles(chapter) {
  const files = getChapterFiles(chapter);
  const diffFiles = files.filter((file) => file.inGitDiff);
  return diffFiles.length > 0 ? diffFiles : files;
}

function openFindingLocation(location, options = {}) {
  const file = getFileById(location.fileId);
  if (!file) return;
  saveCurrentScrollPosition();
  state.activeCanvas = "file";
  state.currentScope = "git-diff";
  state.activeFileId = file.id;
  if (location.side === "original" || location.side === "modified") {
    state.activeDiffSide = location.side;
    state.activeDiffLine = location.line ?? null;
  }
  queueFindingFocus(location, options.findingId || null);
  renderAll({ restoreFileScroll: false });
  ensureFileLoaded(file.id, state.currentScope);
  requestAnimationFrame(applyPendingFindingFocus);
}

function firstExistingFindingLocation(finding) {
  return (finding.locations || []).find((item) => getFileById(item.fileId)) || null;
}

function openFirstFindingLocation(finding) {
  const location = firstExistingFindingLocation(finding);
  if (location) {
    expandDisclosure(state.collapsedFindingIds, finding.id);
    openFindingLocation(location, { findingId: finding.id });
  }
}

function applyEditorOptions() {
  if (!diffEditor) return;
  diffEditor.updateOptions({
    renderSideBySide: activeFileShowsDiff() && !shouldRenderUnifiedForFile(),
    diffWordWrap: state.wrapLines ? "on" : "off",
    hideUnchangedRegions: {
      enabled: activeFileShowsDiff() && state.hideUnchanged,
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
  });
  diffEditor.getOriginalEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
  diffEditor.getModifiedEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
}

function renderTree() {
  ensureActiveFileForScope();
  scheduleSessionSave();
  fileTreeEl.innerHTML = "";
  updateSidebarTabs();
  sourceLabelEl.textContent = workflowTitle.title;
  const analysisStatus = state.aiReview.status === "running"
    ? state.aiReview.message
    : state.reviewMapProgress && !["done", "failed"].includes(state.reviewMapProgress.phase)
      ? state.reviewMapProgress.message
    : state.aiReview.status === "done" || state.aiReview.status === "failed"
      ? state.aiReview.message
      : reviewData.session?.message || reviewData.analysis?.message || "";
  analysisStatusEl.textContent = reviewData.session?.recoveryPath
    ? `${analysisStatus} • Recovery copy saved`
    : analysisStatus;
  analysisStatusEl.title = reviewData.session?.recoveryPath
    ? `Previous local review state: ${reviewData.session.recoveryPath}`
    : analysisStatus;

  const scopedFiles = getScopedFiles();
  const comments = getDraftComments().length;

  const visibleFiles = getFilteredFiles();
  if (visibleFiles.length === 0) {
    const message = state.fileFilter.trim()
      ? `No files match <span class="text-review-text">${escapeHtml(state.fileFilter.trim())}</span>.`
      : `No files in <span class="text-review-text">${escapeHtml(scopeLabel(state.currentScope).toLowerCase())}</span>.`;
    fileTreeEl.innerHTML = `
      <div class="px-3 py-4 text-sm text-review-muted">
        ${message}
      </div>
    `;
  } else if (state.fileFilter.trim()) {
    renderSearchResults(visibleFiles);
  } else {
    renderReviewPlanTree(visibleFiles);
  }

  sidebarTitleEl.textContent = "";
  const filteredSuffix = state.fileFilter.trim() ? ` • ${visibleFiles.length} shown` : "";
  const reviewProgress = fileReviewProgress(scopedFiles);
  setSummary(
    `${aiReviewStatusSummary()}${filteredSuffix}`,
    state.currentScope === "all-files" ? null : scopedDiffstatCounts(scopedFiles, state.currentScope),
    {
      reviewed: reviewProgress.reviewed,
      total: reviewProgress.total,
      staged: comments,
    },
  );
  updateToggleButtons();
  updateSidebarLayout();
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="review-modal-text" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(options.initialValue ?? "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="review-modal-save" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]">${escapeHtml(options.saveLabel ?? "Save")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector("#review-modal-text");
  const close = () => backdrop.remove();
  const save = () => {
    options.onSave(textarea.value.trim());
    close();
  };
  backdrop.querySelector("#review-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#review-modal-save").addEventListener("click", save);
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function suggestedGitHubReviewEvent() {
  const verdict = reviewData.analysis?.approvalPacket?.suggestedVerdict;
  if (verdict === "request-changes") return "REQUEST_CHANGES";
  if (verdict === "approve") return "APPROVE";
  return "COMMENT";
}

function openCheckoutDrawer(title, html) {
  insightPanelTitleEl.textContent = title;
  insightContentEl.innerHTML = html;
  insightPanelEl.className = "review-checkout-drawer flex min-h-0 shrink-0 flex-col border-l border-review-border bg-[#0d1117]";
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
}

function closeCheckoutDrawer() {
  insightPanelEl.className = "hidden min-h-0 shrink-0 flex-col border-l border-review-border bg-[#0d1117] review-checkout-drawer";
  insightPanelTitleEl.textContent = "Submit review";
  insightContentEl.innerHTML = "";
  insightPanelEl.onkeydown = null;
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
}

function isCheckoutDrawerOpen() {
  return !insightPanelEl.classList.contains("hidden");
}

function setPublishUiState(status, message = "") {
  const statusEl = insightContentEl.querySelector("#github-publish-status");
  const submitEl = insightContentEl.querySelector("#github-publish-submit");
  const cancelEl = insightContentEl.querySelector("#github-publish-cancel");
  const eventEl = insightContentEl.querySelector("#github-review-event");
  const bodyEl = insightContentEl.querySelector("#github-review-body");
  const submitting = status === "submitting";

  if (submitEl) {
    submitEl.disabled = submitting;
    submitEl.className = submitting
      ? "cursor-wait rounded-md border border-[rgba(240,246,252,0.1)] bg-[#1f6feb]/70 px-3 py-1.5 text-sm font-medium text-white"
      : "cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#1f6feb] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#388bfd]";
    submitEl.innerHTML = submitting
      ? `Submitting <span class="ml-2 inline-flex items-center gap-1 align-middle"><span class="ai-pulse-dot"></span><span class="ai-pulse-dot"></span><span class="ai-pulse-dot"></span></span>`
      : `Submit review <span class="text-[11px] opacity-70">⌘↵</span>`;
  }
  if (cancelEl) cancelEl.disabled = submitting;
  if (eventEl) eventEl.disabled = submitting;
  if (bodyEl) bodyEl.disabled = submitting;

  if (!statusEl) return;
  if (!message) {
    statusEl.className = "hidden";
    statusEl.textContent = "";
    return;
  }
  const tone = status === "failed"
    ? "border-red-500/30 bg-red-500/10 text-red-300"
    : status === "done"
      ? "border-[#2ea043]/30 bg-[#238636]/12 text-[#7ee787]"
      : "border-[#58a6ff]/30 bg-[#1f6feb]/10 text-[#79c0ff]";
  statusEl.className = `rounded-md border px-3 py-2 text-sm leading-5 ${tone}`;
  statusEl.textContent = message;
}

function markCommentsPublished(publishedComments) {
  const publishedIds = new Set((publishedComments || []).map((comment) => comment.id));
  if (publishedIds.size === 0) return;
  state.comments = applyAuthoritativePublishedCommentState(state.comments, publishedComments);
  publishedIds.forEach((commentId) => commentEditBuffer.remove(commentId));
}

function handlePublishGitHubReviewResult(message) {
  if (message.requestId !== state.publishRequestId) return;
  state.publishRequestId = null;

  if (!message.ok) {
    setPublishUiState("failed", message.message || "GitHub review submission failed.");
    return;
  }

  markCommentsPublished(message.publishedComments || []);
  if (reviewData.session) reviewData.session.publishWarning = null;
  updateSessionNotice();
  setPublishUiState("done", message.message || "Submitted GitHub review.");
  updateCommentsUI();
  saveSessionNow({ showStatus: false });
  setTimeout(() => {
    if (!state.publishRequestId) closeCheckoutDrawer();
  }, 700);
}

function showPublishGitHubModal() {
  syncCommentBodiesFromDOM();
  const submitPayload = buildSubmitPayload();
  const stagedCount = submitPayload.comments.length;
  const findingCounts = findingStatusCounts();
  openCheckoutDrawer("Submit review", `
    <div class="space-y-4">
      <div>
        <div class="text-base font-semibold text-white">Submit review</div>
        <div class="mt-1 text-sm leading-5 text-review-muted">Review the final body while keeping the diff visible.</div>
      </div>
      <div class="mb-4 grid grid-cols-3 gap-2">
        <div class="rounded-md border border-review-border bg-[#010409] px-3 py-2">
          <div class="text-sm font-semibold text-white">${stagedCount}</div>
          <div class="text-[10px] uppercase tracking-wider text-review-muted">Staged comments</div>
        </div>
        <div class="rounded-md border border-review-border bg-[#010409] px-3 py-2">
          <div class="text-sm font-semibold text-[#58a6ff]">${findingCounts.open}</div>
          <div class="text-[10px] uppercase tracking-wider text-review-muted">Findings open</div>
        </div>
        <div class="rounded-md border border-review-border bg-[#010409] px-3 py-2">
          <div class="text-sm font-semibold text-[#3fb950]">${findingCounts.drafted}</div>
          <div class="text-[10px] uppercase tracking-wider text-review-muted">Findings staged</div>
        </div>
      </div>
      <div>
        <label class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-review-muted" for="github-review-event">Verdict</label>
        <select id="github-review-event" class="w-full rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
          <option value="COMMENT">Comment</option>
          <option value="REQUEST_CHANGES">Request changes</option>
          <option value="APPROVE">Approve</option>
        </select>
      </div>
      <div>
        <label class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-review-muted" for="github-review-body">Review body</label>
        <textarea id="github-review-body" class="scrollbar-thin min-h-[260px] max-h-[56vh] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 font-mono text-sm leading-6 text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(reviewData.analysis?.approvalPacket?.body || "")}</textarea>
      </div>
      <div id="github-publish-status" class="hidden"></div>
      <div class="flex justify-end gap-2">
        <button id="github-publish-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1.5 text-sm font-medium text-review-text hover:bg-[#21262d]">Back</button>
        <button id="github-publish-submit" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#1f6feb] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#388bfd]">Submit review <span class="text-[11px] opacity-70">⌘↵</span></button>
      </div>
    </div>
  `);
  const eventSelect = insightContentEl.querySelector("#github-review-event");
  const textarea = insightContentEl.querySelector("#github-review-body");
  const publish = () => {
    if (state.publishRequestId) return;
    syncCommentBodiesFromDOM();
    const requestId = `publish:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const submit = buildSubmitPayload();
    state.publishRequestId = requestId;
    setPublishUiState("submitting", "Submitting review to GitHub...");
    if (!canSendRendererMessage()) {
      state.publishRequestId = null;
      setPublishUiState("failed", "GitHub review submission is only available inside the review app.");
      return;
    }
    sendRendererMessage({
      type: "publish-github-review",
      requestId,
      event: eventSelect.value,
      body: textarea.value.trim(),
      submit,
    });
  };

  eventSelect.value = suggestedGitHubReviewEvent();
  insightContentEl.querySelector("#github-publish-cancel").addEventListener("click", closeCheckoutDrawer);
  insightContentEl.querySelector("#github-publish-submit").addEventListener("click", publish);
  if (reviewData.session?.publishWarning) {
    setPublishUiState("failed", `${reviewData.session.publishWarning} Submit review will retry reconciliation.`);
  }
  insightPanelEl.onkeydown = (event) => {
    if (event.key === "Escape") {
      if (state.publishRequestId) return;
      event.preventDefault();
      closeCheckoutDrawer();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      publish();
    }
  };
  textarea.focus();
}

function showFileCommentModal() {
  const file = activeFile();
  if (!file) return;
  showTextModal({
    title: `File comment for ${getScopeDisplayPath(file, state.currentScope)}`,
    description: `This comment applies to the whole file in ${scopeLabel(state.currentScope).toLowerCase()}.`,
    initialValue: "",
    saveLabel: "Add comment",
    onSave: (value) => {
      if (!value) return;
      state.comments.push({
        id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
        fileId: file.id,
        scope: state.currentScope,
        commitSha: state.currentScope === "commit" ? state.selectedCommitSha : undefined,
        side: "file",
        startLine: null,
        endLine: null,
        body: value,
      });
      submitButton.disabled = false;
      updateCommentsUI();
      scheduleSessionSave();
    },
  });
}

function layoutEditor() {
  if (!diffEditor) return;
  const width = editorContainerEl.clientWidth;
  const height = editorContainerEl.clientHeight;
  if (width <= 0 || height <= 0) return;
  diffEditor.layout({ width, height });
}

function clearViewZones() {
  if (!diffEditor || activeViewZones.length === 0) return;
  const original = diffEditor.getOriginalEditor();
  const modified = diffEditor.getModifiedEditor();
  original.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === original) accessor.removeZone(zone.id);
  });
  modified.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === modified) accessor.removeZone(zone.id);
  });
  activeViewZones = [];
}

function aiFindingIdForComment(comment) {
  const id = String(comment.id || "");
  if (!id.startsWith("ai:")) return null;
  return id.split(":")[1] || null;
}

function commentLifecycleState(comment) {
  const id = String(comment.id || "");
  const status = String(comment.status || "");
  const hasGithubLink = typeof comment.githubUrl === "string" || typeof comment.githubThreadId === "string" || typeof comment.githubCommentId === "string";
  return comment.published === true || comment.isPublished === true || status === "published" || hasGithubLink || id.startsWith("github:") || id.startsWith("published:")
    ? "published"
    : "staged";
}

function commentLifecycleLabel(comment) {
  return commentLifecycleState(comment) === "published" ? "Published" : "Staged";
}

function commentLifecycleBadgeClass(comment) {
  return commentLifecycleState(comment) === "published"
    ? "rounded bg-[#30363d]/50 px-1.5 py-0.5 text-[10px] font-medium text-review-muted"
    : "rounded bg-[#238636]/15 px-1.5 py-0.5 text-[10px] font-medium text-[#3fb950]";
}

function commentProvenance(comment) {
  return aiFindingIdForComment(comment) ? "ai" : "user";
}

function commentGlyphClassName(comment) {
  const provenanceClass = commentLifecycleState(comment) === "published"
    ? "review-comment-glyph-published"
    : commentProvenance(comment) === "ai" ? "review-comment-glyph-staged-ai" : "review-comment-glyph-staged-user";
  return `${provenanceClass} ${disclosureStateClass(isDisclosureExpanded(state.collapsedCommentIds, comment.id))}`;
}

function commentRailClassName(comment) {
  if (commentLifecycleState(comment) === "published") return "review-comment-rail-published";
  return commentProvenance(comment) === "ai" ? "review-comment-rail-staged-ai" : "review-comment-rail-staged-user";
}

function commentMarkerTooltip(comment) {
  const action = isDisclosureExpanded(state.collapsedCommentIds, comment.id) ? "Collapse" : "Expand";
  const stateLabel = commentLifecycleState(comment) === "published" ? "GitHub published thread" : "Local staged comment";
  return `${action} ${stateLabel} · ${commentSourceTitle(comment)}`;
}

function disclosureStateClass(expanded) {
  return expanded ? "review-disclosure-expanded" : "review-disclosure-collapsed";
}

function aiFindingDisclosureLabel(finding) {
  return isAiFindingExpanded(finding.id)
    ? `Collapse AI review: ${finding.title}`
    : `Expand AI review: ${finding.title}`;
}

function commentSourceTitle(comment) {
  if (commentLifecycleState(comment) === "published") return "GitHub thread";
  return aiFindingIdForComment(comment) ? "AI suggestion" : "Your comment";
}

function isCommentEditing(comment) {
  if (commentLifecycleState(comment) === "published") return false;
  return state.editingCommentIds.has(comment.id) || !String(comment.body || "").trim();
}

function focusCommentTextarea(commentId) {
  const textarea = [...document.querySelectorAll("textarea[data-comment-id]")]
    .find((node) => node.getAttribute("data-comment-id") === commentId);
  if (textarea) textarea.focus();
}

function insertTextareaText(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  textarea.selectionStart = start + text.length;
  textarea.selectionEnd = start + text.length;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function updatePlainTextEditorMetrics(textarea) {
  textarea.style.height = "auto";
  const maxHeight = 12 * 22 + 24;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";

  const counter = textarea.closest("[data-comment-block-id]")?.querySelector("[data-comment-counter]");
  if (counter) {
    const value = textarea.value || "";
    const lines = value.length === 0 ? 1 : value.split("\n").length;
    counter.textContent = `${lines} line${lines === 1 ? "" : "s"} • ${value.length} chars`;
  }
}

function bindPlainTextCommentEditor(textarea, comment, container) {
  commentEditBuffer.begin(comment);
  const block = container.querySelector("[data-comment-block-id]");
  const savePolicy = createCommentEditorSavePolicy(() => sessionSaveScheduler.flush());
  updatePlainTextEditorMetrics(textarea);
  textarea.addEventListener("input", () => {
    commentEditBuffer.update(comment, textarea.value);
    updatePlainTextEditorMetrics(textarea);
    scheduleSessionSave();
  });
  textarea.addEventListener("blur", (event) => {
    const nextAction = event.relatedTarget?.closest?.("[data-comment-action]");
    savePolicy.onBlur({ movingToCommentAction: nextAction?.closest("[data-comment-block-id]") === block });
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      insertTextareaText(textarea, "    ");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      savePolicy.beforeAction();
      cancelCommentEdit(comment);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      savePolicy.beforeAction();
      saveCommentEdit(comment, container.querySelector("[data-comment-block-id]"));
    }
  });
}

function deleteComment(comment) {
  if (commentLifecycleState(comment) === "published") return;
  state.comments = state.comments.filter((item) => item.id !== comment.id);
  commentEditBuffer.remove(comment.id);
  state.editingCommentIds.delete(comment.id);
  state.collapsedCommentIds.delete(comment.id);
  const findingId = aiFindingIdForComment(comment);
  if (findingId && state.findingStatuses[findingId] === "accepted-comment") {
    state.findingStatuses[findingId] = "new";
  }
  updateCommentsUI();
  scheduleSessionSave();
}

function enterCommentEdit(comment) {
  if (commentLifecycleState(comment) === "published") return;
  state.collapsedCommentIds.delete(comment.id);
  commentEditBuffer.begin(comment);
  state.editingCommentIds.add(comment.id);
  updateCommentsUI();
  setTimeout(() => focusCommentTextarea(comment.id), 50);
}

function saveCommentEdit(comment, block) {
  const textarea = block?.querySelector("textarea[data-comment-id]");
  if (textarea) commentEditBuffer.update(comment, textarea.value);
  if (commentEditBuffer.save(comment).deleteComment) {
    deleteComment(comment);
    return;
  }
  state.editingCommentIds.delete(comment.id);
  updateCommentsUI();
  scheduleSessionSave();
  if (comment.side !== "file") {
    setTimeout(() => focusDiffLine(comment.side, comment.startLine, comment.endLine ?? comment.startLine), 0);
  }
}

function cancelCommentEdit(comment) {
  if (commentEditBuffer.cancel(comment).deleteComment) {
    deleteComment(comment);
    return;
  }
  state.editingCommentIds.delete(comment.id);
  updateCommentsUI();
  scheduleSessionSave();
  if (comment.side !== "file") {
    setTimeout(() => focusDiffLine(comment.side, comment.startLine, comment.endLine ?? comment.startLine), 0);
  }
}

function bindCommentBlockActions(root = document) {
  root.querySelectorAll("[data-comment-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const commentId = button.getAttribute("data-comment-id");
      const comment = state.comments.find((item) => item.id === commentId);
      if (!comment) return;
      const action = button.getAttribute("data-comment-action");
      const block = button.closest("[data-comment-block-id]");
      if (action === "edit") enterCommentEdit(comment);
      if (action === "delete") deleteComment(comment);
      if (action === "save") saveCommentEdit(comment, block);
      if (action === "cancel") cancelCommentEdit(comment);
    });
  });
}

function stagedCommentInnerHtml(comment) {
  const locationTitle = comment.side === "file"
    ? `File comment • ${scopeLabel(comment.scope)}`
    : `${comment.side === "original" ? "Original" : "Modified"} line ${comment.startLine} • ${scopeLabel(comment.scope)}`;
  const sourceTitle = commentSourceTitle(comment);
  const lifecycleLabel = commentLifecycleLabel(comment);
  const lifecycleBadgeClass = commentLifecycleBadgeClass(comment);
  const published = commentLifecycleState(comment) === "published";
  const editing = isCommentEditing(comment);
  if (editing) commentEditBuffer.begin(comment);
  const body = commentEditBuffer.bodyFor(comment);

  if (editing) {
    return `
      <div data-comment-block-id="${escapeHtml(comment.id)}">
        <div class="mb-2 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="${lifecycleBadgeClass}">${escapeHtml(lifecycleLabel)}</span>
              <span class="text-xs font-semibold text-review-text">${escapeHtml(sourceTitle)}</span>
            </div>
            <div class="mt-0.5 truncate text-[11px] text-review-muted">${escapeHtml(locationTitle)}</div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button data-comment-action="cancel" data-comment-id="${escapeHtml(comment.id)}" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-xs font-medium text-review-muted hover:bg-[#21262d]">Cancel <span class="text-[10px] opacity-70">Esc</span></button>
            <button data-comment-action="save" data-comment-id="${escapeHtml(comment.id)}" class="cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-2.5 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25">Save <span class="text-[10px] opacity-70">Enter</span></button>
          </div>
        </div>
        <textarea data-comment-id="${escapeHtml(comment.id)}" data-comment-editing="true" class="scrollbar-thin min-h-[76px] w-full resize-none rounded-md border border-review-border bg-[#010409] px-3 py-2 font-mono text-sm leading-[22px] text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Write a review comment">${escapeHtml(body)}</textarea>
        <div class="mt-1 text-right text-[10px] text-review-muted" data-comment-counter></div>
      </div>
    `;
  }

  return `
    <div data-comment-block-id="${escapeHtml(comment.id)}">
        <div class="mb-2 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
            <span class="${lifecycleBadgeClass}">${escapeHtml(lifecycleLabel)}</span>
            <span class="text-xs font-semibold text-review-text">${escapeHtml(sourceTitle)}</span>
          </div>
          <div class="mt-0.5 truncate text-[11px] text-review-muted">${escapeHtml(locationTitle)}</div>
        </div>
        ${published ? `<div class="shrink-0 text-[11px] text-review-muted">Read only</div>` : `<div class="flex shrink-0 items-center gap-2">
          <button data-comment-action="edit" data-comment-id="${escapeHtml(comment.id)}" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-xs font-medium text-review-muted hover:bg-[#21262d]">Edit</button>
          <button data-comment-action="delete" data-comment-id="${escapeHtml(comment.id)}" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-xs font-medium text-review-muted hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400">Delete</button>
        </div>`}
      </div>
      <div class="whitespace-pre-wrap rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm leading-5 text-review-text">${escapeHtml(body)}</div>
    </div>
  `;
}

function stagedCommentBlockHtml(comment) {
  return `<div class="rounded-md border border-review-border bg-[#010409] p-3">${stagedCommentInnerHtml(comment)}</div>`;
}

function renderCommentDOM(comment) {
  const container = document.createElement("div");
  container.className = "view-zone-container";
  container.innerHTML = stagedCommentInnerHtml(comment);
  container.addEventListener("click", () => {
    state.activeInsight = { type: "comment", id: comment.id };
  });
  bindCommentBlockActions(container);
  const textarea = container.querySelector("textarea[data-comment-id]");
  if (textarea) bindPlainTextCommentEditor(textarea, comment, container);
  if (textarea && !comment.body) setTimeout(() => textarea.focus(), 50);
  return container;
}

function getInlineAiFindingEntries(file) {
  if (!file || state.currentScope !== "git-diff" || !activeFileShowsDiff()) return [];
  return getOpenInlineFindingEntriesForFile(file);
}

function hasOpenInlineFindingLocations(finding) {
  for (const location of finding.locations || []) {
    const file = getFileById(location.fileId);
    if (!file || location.line == null || location.side === "file") continue;
    const comparison = getScopeComparison(file, "git-diff");
    if (!comparison) continue;
    if (isFindingLocationDismissed(finding, location)) continue;
    if (clampRangeToCommentable(location.line, location.line, rangesForSide(comparison, location.side))) {
      return true;
    }
  }
  return false;
}

function createDraftCommentFromFinding(finding, location) {
  const body = (finding.suggestedComment || "").trim();
  if (!body) return;
  const file = activeFile();
  const comparison = activeComparison();
  const commentRange = file && comparison && location.fileId === file.id && state.currentScope === "git-diff" && location.line != null
    ? clampRangeToCommentable(location.line, location.line, rangesForSide(comparison, location.side))
    : null;
  if (!commentRange || location.side === "file") {
    state.activeInsight = { type: "finding", id: finding.id };
    renderTree();
    return;
  }
  let comment = state.comments.find((item) => String(item.id || "").startsWith(`ai:${finding.id}:`)) || null;
  if (!comment) {
    comment = {
      id: `ai:${finding.id}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: location.fileId,
      scope: state.currentScope,
      commitSha: state.currentScope === "commit" ? state.selectedCommitSha : undefined,
      side: location.side,
      startLine: commentRange.startLine,
      endLine: commentRange.endLine,
      body,
    };
    state.comments.push(comment);
  }
  state.findingStatuses[finding.id] = "accepted-comment";
  delete state.acceptedFindingComments[finding.id];
  expandDisclosure(state.collapsedFindingIds, finding.id);
  state.collapsedCommentIds.delete(comment.id);
  commentEditBuffer.begin(comment);
  state.editingCommentIds.add(comment.id);
  state.activeInsight = { type: "finding", id: finding.id };
  updateCommentsUI();
  setTimeout(() => focusCommentTextarea(comment.id), 50);
}

function dismissFinding(finding) {
  state.findingStatuses[finding.id] = "dismissed";
  delete state.acceptedFindingComments[finding.id];
  expandDisclosure(state.collapsedFindingIds, finding.id);
  if (state.activeInsight.type === "finding" && state.activeInsight.id === finding.id) {
    state.activeInsight = { type: "default", id: null };
  }
  updateCommentsUI();
}

function dismissFindingLocation(finding, location) {
  state.dismissedFindingLocationKeys.add(findingLocationKey(finding, location));
  expandDisclosure(state.collapsedFindingIds, finding.id);
  if (!hasOpenInlineFindingLocations(finding)) {
    state.findingStatuses[finding.id] = "dismissed";
    delete state.acceptedFindingComments[finding.id];
  }
  if (state.activeInsight.type === "finding" && state.activeInsight.id === finding.id) {
    state.activeInsight = { type: "default", id: null };
  }
  updateCommentsUI();
}

function createFirstDraftCommentFromFinding(finding) {
  const location = firstDraftableFindingLocation(finding);
  if (!location) return;
  const file = getFileById(location.fileId);
  if (!file) return;
  saveCurrentScrollPosition();
  state.currentScope = "git-diff";
  state.activeFileId = file.id;
  state.activeDiffSide = location.side;
  state.activeDiffLine = location.line;
  createDraftCommentFromFinding(finding, location);
  ensureFileLoaded(file.id, state.currentScope);
  renderAll({ restoreFileScroll: true });
}

function draftCommentForFinding(finding) {
  return state.comments.find((comment) => String(comment.id || "").startsWith(`ai:${finding.id}:`)) || null;
}

function renderAiFindingZoneDOM(finding, location) {
  const container = document.createElement("div");
  container.className = "view-zone-container ai-finding-zone";
  container.style.borderLeftColor = severityAccentColor(finding.severity);
  container.setAttribute("data-ai-finding-id", finding.id);
  container.setAttribute("data-ai-finding-side", location.side);
  container.setAttribute("data-ai-finding-line", String(location.line));
  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2 text-xs font-semibold text-review-text">
        <span class="rounded bg-[#8957e5]/15 px-1.5 py-0.5 text-[10px] text-[#d2a8ff]">AI</span>
        <span class="truncate">Review item • ${escapeHtml(humanizeToken(finding.kind))}</span>
      </div>
      <button type="button" data-action="collapse-finding" class="review-card-disclosure review-disclosure-expanded shrink-0 cursor-pointer rounded border border-review-border bg-[#0d1117] text-[#d2a8ff] hover:border-[#8957e5]/60 hover:bg-[#8957e5]/12 focus:outline-none focus:ring-1 focus:ring-[#8957e5]/70" aria-label="Collapse AI review" title="Collapse AI review"></button>
    </div>
    <div class="text-sm font-medium leading-5 text-white">${escapeHtml(finding.title)}</div>
    <div class="mt-1 line-clamp-2 text-xs leading-5 text-review-muted">${escapeHtml(finding.explanation)}</div>
    <div class="mt-2 flex items-center justify-end gap-2 border-t border-review-border pt-2">
      <button data-action="dismiss-finding" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-xs font-medium text-review-muted hover:bg-[#21262d]">Dismiss <kbd class="ml-2 rounded bg-[#30363d]/70 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-review-muted">X</kbd></button>
      <button data-action="stage-comment" class="cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-2.5 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25">Stage comment <kbd class="ml-2 rounded bg-[#238636]/25 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[#7ee787]">S</kbd></button>
    </div>
  `;
  container.addEventListener("click", () => {
    state.activeInsight = { type: "finding", id: finding.id };
  });
  container.querySelector("[data-action='collapse-finding']").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleInlineFinding({ finding, location });
  });
  container.querySelector("[data-action='stage-comment']").addEventListener("click", () => createDraftCommentFromFinding(finding, location));
  container.querySelector("[data-action='dismiss-finding']").addEventListener("click", () => dismissFindingLocation(finding, location));
  return container;
}

function canCommentOnSide(file, side) {
  if (!file) return false;
  const comparison = activeComparison();
  if (side === "original") {
    return comparison != null && comparison.hasOriginal;
  }
  return comparison != null ? comparison.hasModified : file.hasWorkingTreeFile;
}

function isActiveFileReady() {
  const file = activeFile();
  if (!file) return false;
  const requestState = getRequestState(file.id, state.currentScope);
  return requestState.contents != null && requestState.error == null;
}

function getInlineCommentsForFile(file = activeFile()) {
  return file
    ? state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && (comment.scope !== "commit" || comment.commitSha === state.selectedCommitSha) && comment.side !== "file")
    : [];
}

function githubFilesByPath() {
  const result = new Map();
  for (const file of reviewData.files.filter((item) => item.inGitDiff)) {
    for (const path of [file.path, file.gitDiff?.oldPath, file.gitDiff?.newPath].filter(Boolean)) {
      const matches = result.get(path) || [];
      if (!matches.some((item) => item.id === file.id)) matches.push(file);
      result.set(path, matches);
    }
  }
  return result;
}

function locateGithubThread(thread) {
  if (!state.githubContext || !originalModel || !modifiedModel) return null;
  return locateCurrentThread(thread, {
    context: state.githubContext,
    filesByPath: githubFilesByPath(),
    originalLineCount: originalModel.getLineCount(),
    modifiedLineCount: modifiedModel.getLineCount(),
  });
}

function getInlineGithubThreadEntries(file = activeFile()) {
  if (!file || state.currentScope !== "git-diff" || !state.githubContext) return [];
  const threads = state.githubContextFilter === "all"
    ? state.githubContext.threads.filter((thread) => !thread.isOutdated)
    : currentUnresolvedGithubThreads();
  return threads.flatMap((thread) => {
    const location = locateGithubThread(thread);
    return location?.fileId === file.id ? [{ thread, location }] : [];
  });
}

function renderGithubThreadZoneDOM(thread, location) {
  const container = document.createElement("div");
  container.className = "view-zone-container review-github-thread-zone";
  container.dataset.githubThreadId = thread.id;
  const comments = (thread.comments || []).map((comment) => `
    <div class="border-t border-review-border py-3 first:border-t-0 first:pt-0">
      <div class="text-[10px] text-review-muted">${escapeHtml(comment.author || "ghost")} · ${escapeHtml(new Date(comment.createdAt).toLocaleString())}</div>
      <div class="review-context-markdown mt-1">${renderSafeMarkdown(comment.body || "")}</div>
      <button type="button" data-external-url="${escapeHtml(comment.url || "")}" class="mt-2 cursor-pointer text-[10px] text-blue-400 hover:text-blue-300">View on GitHub ↗</button>
    </div>
  `).join("");
  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2 text-xs font-semibold text-review-text"><span class="text-review-muted">GitHub</span><span class="truncate">Published thread</span></div>
      <button type="button" data-action="collapse-github-thread" class="review-card-disclosure review-disclosure-expanded shrink-0 cursor-pointer rounded border border-review-border bg-[#0d1117] text-review-muted" aria-label="Collapse GitHub thread" title="Collapse GitHub thread"></button>
    </div>
    ${comments}
  `;
  container.querySelector("[data-action='collapse-github-thread']")?.addEventListener("click", () => {
    state.githubThreadDisclosure.collapse(thread.id);
    syncViewZones();
    updateDecorations();
  });
  container.querySelectorAll("[data-external-url]").forEach((button) => button.addEventListener("click", () => {
    const url = safeExternalUrl(button.dataset.externalUrl || "");
    if (url) sendRendererMessage({ type: "open-external-url", url });
  }));
  return container;
}

function findInlineGithubThreadAtLine(side, line) {
  return getInlineGithubThreadEntries().find((entry) => entry.location.side === side && entry.location.line === line) || null;
}

function toggleInlineGithubThreadAtLine(side, line) {
  const entry = findInlineGithubThreadAtLine(side, line);
  if (!entry) return false;
  state.githubThreadDisclosure.toggle(entry.thread.id);
  syncViewZones();
  updateDecorations();
  focusDiffLine(side, line, line);
  return true;
}

function findInlineCommentAtLine(side, line) {
  return getInlineCommentsForFile()
    .filter((comment) => comment.side === side && comment.startLine === line)
    .sort((left, right) => {
      const leftPublished = commentLifecycleState(left) === "published" ? 1 : 0;
      const rightPublished = commentLifecycleState(right) === "published" ? 1 : 0;
      return leftPublished - rightPublished;
    })[0] || null;
}

function toggleInlineCommentAtLine(side, line) {
  const comment = findInlineCommentAtLine(side, line);
  if (!comment) return false;

  toggleDisclosure(state.collapsedCommentIds, comment.id);
  state.activeInsight = { type: "comment", id: comment.id };
  syncViewZones();
  updateDecorations();
  renderTree();
  focusDiffLine(side, line, comment.endLine ?? line);
  return true;
}

function syncViewZones() {
  clearViewZones();
  if (!diffEditor || !isActiveFileReady()) return;
  const file = activeFile();
  if (!file) return;

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const inlineComments = getInlineCommentsForFile(file);

  inlineComments.forEach((item) => {
    if (isCommentEditing(item)) state.collapsedCommentIds.delete(item.id);
    if (state.collapsedCommentIds.has(item.id)) return;
    const editor = item.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderCommentDOM(item);

    editor.changeViewZones((accessor) => {
      const lineCount = typeof item.body === "string" && item.body.length > 0 ? item.body.split("\n").length : 1;
      const editing = isCommentEditing(item);
      const id = accessor.addZone({
        afterLineNumber: item.startLine,
        heightInPx: editing ? Math.max(132, lineCount * 22 + 68) : Math.max(104, lineCount * 20 + 72),
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });

  getInlineGithubThreadEntries(file).forEach(({ thread, location }) => {
    if (!state.githubThreadDisclosure.isExpanded(thread.id)) return;
    const editor = location.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderGithubThreadZoneDOM(thread, location);
    editor.changeViewZones((accessor) => {
      const id = accessor.addZone({
        afterLineNumber: location.line,
        heightInPx: Math.max(112, 72 + (thread.comments || []).reduce((total, comment) => total + Math.max(36, String(comment.body || "").split("\n").length * 20), 0)),
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });

  getInlineAiFindingEntries(file)
    .filter(({ finding }) => isAiFindingExpanded(finding.id))
    .forEach(({ finding, location }) => {
      const editor = location.side === "original" ? originalEditor : modifiedEditor;
      const domNode = renderAiFindingZoneDOM(finding, location);
      editor.changeViewZones((accessor) => {
        const id = accessor.addZone({
          afterLineNumber: location.line,
          heightInPx: 142,
          domNode,
        });
        activeViewZones.push({ id, editor });
      });
    });
}

function updateDecorations() {
  if (!diffEditor || !monacoApi) return;
  const comments = getInlineCommentsForFile();
  const findings = getInlineAiFindingEntries(activeFile());
  const githubThreads = getInlineGithubThreadEntries(activeFile());
  const originalRanges = [];
  const modifiedRanges = [];
  const commentedLines = new Set();

  for (const comment of comments) {
    commentedLines.add(`${comment.side}:${comment.startLine}`);
    const range = {
      range: new monacoApi.Range(comment.startLine, 1, comment.startLine, 1),
      options: {
        isWholeLine: true,
        className: commentRailClassName(comment),
        glyphMarginClassName: commentGlyphClassName(comment),
        glyphMarginHoverMessage: { value: commentMarkerTooltip(comment) },
      },
    };
    if (comment.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  for (const { thread, location } of githubThreads) {
    const expanded = state.githubThreadDisclosure.isExpanded(thread.id);
    const range = {
      range: new monacoApi.Range(location.line, 1, location.line, 1),
      options: {
        isWholeLine: expanded,
        className: expanded ? "review-github-thread-rail" : "",
        glyphMarginClassName: `review-github-thread-glyph ${expanded ? "review-disclosure-expanded" : "review-disclosure-collapsed"}`,
        glyphMarginHoverMessage: { value: expanded ? "Collapse published GitHub thread" : "Expand published GitHub thread" },
      },
    };
    if (location.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  for (const { finding, location } of findings) {
    if (commentedLines.has(`${location.side}:${location.line}`)) continue;
    const visible = isAiFindingExpanded(finding.id);
    const active = isAiFindingActive(finding.id);
    const disclosureClass = disclosureStateClass(visible);
    const overviewLane = monacoApi.editor.OverviewRulerLane?.Right ?? 4;
    const minimapPosition = monacoApi.editor.MinimapPosition?.Inline ?? 1;
    const range = {
      range: new monacoApi.Range(location.line, 1, location.line, 1),
      options: {
        isWholeLine: visible,
        className: visible ? "review-ai-finding-rail-active" : "",
        glyphMarginClassName: `review-ai-finding-glyph ${active ? "review-ai-finding-glyph-active" : ""} ${disclosureClass}`,
        glyphMarginHoverMessage: { value: aiFindingDisclosureLabel(finding) },
        overviewRuler: {
          color: "rgba(210, 168, 255, 0.58)",
          position: overviewLane,
        },
        minimap: {
          color: "rgba(210, 168, 255, 0.48)",
          position: minimapPosition,
        },
      },
    };
    if (location.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, originalRanges);
  modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, modifiedRanges);
}

function renderFileComments() {
  fileCommentsContainer.innerHTML = "";
  const file = activeFile();
  if (!file) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  const fileComments = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && (comment.scope !== "commit" || comment.commitSha === state.selectedCommitSha) && comment.side === "file");

  if (fileComments.length === 0) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  fileCommentsContainer.className = "border-b border-review-border bg-[#0d1117] px-4 py-4 space-y-4";
  fileComments.forEach((comment) => {
    const dom = renderCommentDOM(comment);
    dom.className = "rounded-lg border border-review-border bg-review-panel p-4";
    fileCommentsContainer.appendChild(dom);
  });
}

function getPlaceholderContents(file, scope) {
  const path = getScopeDisplayPath(file, scope);
  const requestState = getRequestState(file.id, scope);
  if (requestState.error) {
    const body = `Failed to load ${path}\n\n${requestState.error}`;
    return { originalContent: body, modifiedContent: body };
  }
  const body = `Loading ${path}...`;
  return { originalContent: body, modifiedContent: body };
}

function getMountedContents(file, scope = state.currentScope) {
  return getRequestState(file.id, scope).contents || getPlaceholderContents(file, scope);
}

function chapterBriefHtml(chapter) {
  const files = getChapterDisplayFiles(chapter);
  const progress = chapterReviewProgress(chapter);
  const counts = chapterDiffstatCounts(chapter);
  const findings = chapterFindings(chapter).filter((finding) => (state.findingStatuses[finding.id] || "new") === "new");
  const visits = chapter.visits || [];
  const evidence = chapter.testEvidence || [];
  const firstFileId = firstExistingChapterFileId(chapter);
  const reviewedLabel = progress.total > 0 ? `${progress.reviewed}/${progress.total} reviewed` : "No files";

  return `
    <div class="mx-auto w-full max-w-5xl px-8 py-8">
      <div class="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-review-border pb-5">
        <div class="min-w-0">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="${chapterPriorityBadgeClass(chapter.priority)}">${escapeHtml(chapterPriorityLabel(chapter.priority))}</span>
            <span class="${reviewStatusBadgeClass(progress.total > 0 && progress.reviewed >= progress.total)}">${escapeHtml(reviewedLabel)}</span>
            ${diffstatHtml(counts, { compact: true })}
          </div>
          <h1 class="max-w-3xl text-2xl font-semibold leading-tight text-white">${escapeHtml(chapterDisplayTitle(chapter))}</h1>
          <p class="mt-3 max-w-3xl text-sm leading-6 text-review-muted">${escapeHtml(chapter.summary || "Review the changed files in this area before marking it complete.")}</p>
        </div>
        ${firstFileId ? `<button type="button" data-open-chapter-file="${escapeHtml(firstFileId)}" class="cursor-pointer rounded-md border border-[#1f6feb]/40 bg-[#1f6feb] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#388bfd]">Start review</button>` : ""}
      </div>

      <div class="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <section class="rounded-lg border border-review-border bg-[#010409] p-4">
          <div class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-review-muted">Why this matters</div>
          <p class="text-sm leading-6 text-review-text">${escapeHtml(chapter.whyItMatters || chapter.summary)}</p>
          ${chapter.priorityReason ? `<p class="mt-2 text-xs leading-5 text-review-muted">${escapeHtml(chapter.priorityReason)}</p>` : ""}
          <div class="mt-4 grid grid-cols-3 gap-2">
            <div class="rounded-md bg-[#161b22] px-3 py-2">
              <div class="text-base font-semibold text-white">${files.length}</div>
              <div class="text-[10px] uppercase tracking-wider text-review-muted">Files</div>
            </div>
            <div class="rounded-md bg-[#161b22] px-3 py-2">
              <div class="text-base font-semibold text-[#3fb950]">+${Math.max(0, counts.added || 0)}</div>
              <div class="text-[10px] uppercase tracking-wider text-review-muted">Added lines</div>
            </div>
            <div class="rounded-md bg-[#161b22] px-3 py-2">
              <div class="text-base font-semibold text-[#f85149]">-${Math.max(0, counts.deleted || 0)}</div>
              <div class="text-[10px] uppercase tracking-wider text-review-muted">Deleted lines</div>
            </div>
          </div>
        </section>

        <section class="rounded-lg border border-review-border bg-[#010409] p-4">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">AI findings</div>
            <span class="rounded bg-[#161b22] px-1.5 py-0.5 text-[10px] font-medium text-review-muted">${findings.length} open</span>
          </div>
          <div class="space-y-2">
            ${findings.length > 0
              ? findings.slice(0, 4).map((finding) => `
                <button type="button" data-finding-id="${escapeHtml(finding.id)}" class="block w-full cursor-pointer rounded-md border border-review-border bg-[#0d1117] px-3 py-2 text-left hover:border-[#8957e5]/50 hover:bg-[#161b22]">
                  <div class="flex items-center gap-2">
                    <span class="${severityBadgeClass(finding.severity)}">${escapeHtml(humanizeToken(finding.kind))}</span>
                    <span class="min-w-0 truncate text-xs font-semibold text-review-text">${escapeHtml(finding.title)}</span>
                  </div>
                </button>
              `).join("")
              : `<div class="text-sm text-review-muted">No open AI findings in this area.</div>`}
          </div>
        </section>
      </div>

      ${chapter.reviewQuestions?.length ? `<section class="mt-4 border-y border-review-border py-4">
        <div class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-review-muted">Questions to answer</div>
        <ul class="space-y-1.5 text-sm leading-5 text-review-text">${chapter.reviewQuestions.map((question) => `<li class="flex gap-2"><span class="text-[#d2a8ff]">•</span><span>${escapeHtml(question)}</span></li>`).join("")}</ul>
      </section>` : ""}

      <section class="mt-4 rounded-lg border border-review-border bg-[#010409] p-4">
        <div class="mb-3 text-[11px] font-semibold uppercase tracking-wider text-review-muted">Review order</div>
        <div class="divide-y divide-review-border/70">
          ${(visits.length > 0 ? visits : files.map((file) => ({ id: `file-${file.id}`, fileId: file.id, role: "implementation", reason: "Review this changed file.", focus: [] }))).map((visit, index) => {
            const file = getFileById(visit.fileId);
            if (!file) return "";
            const display = fileDisplayParts(file, getScopeDisplayPath(file, state.currentScope) || file.path);
            return `
              <button type="button" data-open-chapter-file="${escapeHtml(file.id)}" data-review-visit-id="${escapeHtml(visit.id)}" class="flex w-full cursor-pointer items-center justify-between gap-3 py-2 text-left hover:text-white">
                <span class="flex min-w-0 items-start gap-3">
                  <span class="mt-0.5 w-5 shrink-0 text-xs font-semibold text-review-muted">${index + 1}</span>
                  <span class="min-w-0">
                    <span class="block truncate text-sm font-medium text-review-text">${escapeHtml(display.filename)}</span>
                    <span class="mt-0.5 block text-[11px] leading-4 text-review-muted">${escapeHtml(humanizeToken(visit.role))} · ${escapeHtml(visit.reason || display.directory || "Review changed behavior")}</span>
                  </span>
                </span>
                <span class="shrink-0">${diffstatHtml(fileDiffstatCounts(file), { compact: true, blocks: 0 })}</span>
              </button>
            `;
          }).join("")}
        </div>
      </section>

      ${(evidence.length > 0 || chapter.exitCriteria?.length) ? `<section class="mt-4 grid gap-4 border-t border-review-border pt-4 lg:grid-cols-2">
        <div>
          <div class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-review-muted">Evidence and gaps</div>
          ${evidence.length > 0 ? evidence.map((item) => `<div class="mb-2 text-xs leading-5"><span class="text-[#3fb950]">Proves:</span> ${escapeHtml((item.proves || []).join(" · ") || "Linked verification")}${item.doesNotProve?.length ? `<br><span class="text-[#d29922]">Does not prove:</span> ${escapeHtml(item.doesNotProve.join(" · "))}` : ""}</div>`).join("") : `<p class="text-xs text-review-muted">No explicit verification evidence was identified.</p>`}
        </div>
        <div>
          <div class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-review-muted">Done when</div>
          <ul class="space-y-1 text-xs leading-5 text-review-text">${(chapter.exitCriteria || []).map((criterion) => `<li>• ${escapeHtml(criterion)}</li>`).join("")}</ul>
        </div>
      </section>` : ""}
    </div>
  `;
}

function mountChapterBrief(chapter) {
  if (!chapter) return;
  clearViewZones();
  if (diffEditor) {
    originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, []);
    modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, []);
    originalKeyboardDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalKeyboardDecorations, []);
    modifiedKeyboardDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedKeyboardDecorations, []);
  }
  editorContainerEl.classList.add("hidden");
  chapterBriefContainerEl.classList.remove("hidden");
  fileCommentsContainer.className = "hidden border-b border-review-border bg-[#0d1117] px-4 py-0";
  currentFileLabelEl.innerHTML = `<span class="truncate">${escapeHtml(chapterDisplayTitle(chapter))}</span>`;
  modeHintEl.textContent = chapter.summary || "Review area";
  chapterBriefContainerEl.innerHTML = chapterBriefHtml(chapter);
  chapterBriefContainerEl.querySelectorAll("[data-open-chapter-file]").forEach((button) => {
    button.addEventListener("click", () => {
      const visitId = button.getAttribute("data-review-visit-id");
      if (visitId && visitsForFile(button.getAttribute("data-open-chapter-file")).some((visit) => visit.id === visitId)) state.activeVisitId = visitId;
      openFile(button.getAttribute("data-open-chapter-file"));
    });
  });
  chapterBriefContainerEl.querySelectorAll("[data-finding-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const finding = getReviewFinding(button.getAttribute("data-finding-id"));
      if (finding) openFirstFindingLocation(finding);
    });
  });
  updateToggleButtons();
}

function mountFile(options = {}) {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  state.activeCanvas = "file";
  chapterBriefContainerEl.classList.add("hidden");
  editorContainerEl.classList.remove("hidden");
  if (!file) {
    currentFileLabelEl.textContent = "No file selected";
    clearViewZones();
    const nextModels = replaceDiffEditorModels(
      diffEditor,
      { original: originalModel, modified: modifiedModel },
      {
        createOriginal: () => monacoApi.editor.createModel("", "plaintext"),
        createModified: () => monacoApi.editor.createModel("", "plaintext"),
      },
    );
    originalModel = nextModels.original;
    modifiedModel = nextModels.modified;
    applyEditorOptions();
    updateDecorations();
    renderFileComments();
    requestAnimationFrame(layoutEditor);
    return;
  }

  ensureFileLoaded(file.id, state.currentScope);

  const preserveScroll = options.preserveScroll === true;
  const scrollState = preserveScroll ? captureScrollState() : null;
  const language = inferLanguage(getScopeFilePath(file) || file.path);
  const contents = getMountedContents(file, state.currentScope);
  const reviewed = isFileReviewed(file.id);
  const chapter = chapterForFile(file.id);
  const activeVisit = visitsForFile(file.id).find((visit) => visit.id === state.activeVisitId) || null;
  const visitChapter = activeVisit == null ? null : getReviewChapters().find((item) => (item.visits || []).some((visit) => visit.id === activeVisit.id)) || null;
  const visibleChapter = visitChapter || chapter;
  const chapterLabel = visibleChapter ? chapterDisplayTitle(visibleChapter) : "";
  const visitIndex = visibleChapter && activeVisit ? (visibleChapter.visits || []).findIndex((visit) => visit.id === activeVisit.id) : -1;
  const displayPath = getScopeDisplayPath(file, state.currentScope);

  clearViewZones();
  currentFileLabelEl.innerHTML = `
    <span class="flex min-w-0 items-center gap-2 ${reviewed ? "opacity-70" : ""}">
      ${reviewed ? `<span class="shrink-0 text-[12px] text-[#3fb950]">✓</span>` : ""}
      ${chapterLabel ? `<span class="min-w-0 truncate text-review-muted">${escapeHtml(chapterLabel)}</span><span class="shrink-0 text-review-muted">→</span>` : ""}
      ${activeVisit ? `<span class="shrink-0 rounded bg-[#8957e5]/12 px-1.5 py-0.5 text-[10px] font-medium text-[#d2a8ff]">${escapeHtml(humanizeToken(activeVisit.role))}${visitIndex >= 0 ? ` ${visitIndex + 1}/${visibleChapter.visits.length}` : ""}</span>` : ""}
      <span class="min-w-0 truncate">${escapeHtml(displayPath)}</span>
      ${diffstatHtml(fileDiffstatCounts(file), { compact: true })}
    </span>
  `;

  const nextModels = replaceDiffEditorModels(
    diffEditor,
    { original: originalModel, modified: modifiedModel },
    {
      createOriginal: () => monacoApi.editor.createModel(contents.originalContent, language),
      createModified: () => monacoApi.editor.createModel(contents.modifiedContent, language),
    },
  );
  originalModel = nextModels.original;
  modifiedModel = nextModels.modified;
  applyEditorOptions();
  syncViewZones();
  updateDecorations();
  renderFileComments();
  requestAnimationFrame(() => {
    layoutEditor();
    if (options.restoreFileScroll) restoreFileScrollPosition();
    if (options.preserveScroll) restoreScrollState(scrollState);
    applyPendingHunkFocus();
    applyPendingFindingFocus();
    applyPendingGithubThreadFocus();
    setTimeout(() => {
      layoutEditor();
      if (options.restoreFileScroll) restoreFileScrollPosition();
      if (options.preserveScroll) restoreScrollState(scrollState);
      applyPendingHunkFocus();
      applyPendingFindingFocus();
      applyPendingGithubThreadFocus();
    }, 50);
  });
}

function syncCommentBodiesFromDOM() {
  const textareas = document.querySelectorAll("textarea[data-comment-id]");
  textareas.forEach((textarea) => {
    const commentId = textarea.getAttribute("data-comment-id");
    const comment = state.comments.find((item) => item.id === commentId);
    if (comment) commentEditBuffer.update(comment, textarea.value);
  });
}

function updateCommentsUI() {
  renderTree();
  syncViewZones();
  updateDecorations();
  renderFileComments();
}

function renderAll(options = {}) {
  renderTree();
  submitButton.disabled = false;
  if (state.activeCanvas === "chapter" && state.activeInsight.type === "chapter") {
    const chapter = getReviewChapter(state.activeInsight.id);
    if (chapter) {
      mountChapterBrief(chapter);
      return;
    }
    state.activeCanvas = "file";
  }
  if (diffEditor && monacoApi) {
    mountFile(options);
    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
    });
  } else {
    renderFileComments();
  }
}

function addInlineComment(side, startLine, endLine = startLine) {
  const file = activeFile();
  if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return false;
  const ranges = rangesForSide(activeComparison(), side);
  const commentRange = clampRangeToCommentable(startLine, endLine, ranges);
  if (!commentRange) return false;

  const comment = {
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    fileId: file.id,
    scope: state.currentScope,
    commitSha: state.currentScope === "commit" ? state.selectedCommitSha : undefined,
    side,
    startLine: commentRange.startLine,
    endLine: commentRange.endLine,
    body: "",
  };
  state.comments.push(comment);
  commentEditBuffer.begin(comment);
  state.editingCommentIds.add(comment.id);
  state.collapsedCommentIds.delete(comment.id);
  state.activeInsight = { type: "comment", id: comment.id };
  updateCommentsUI();
  focusDiffLine(side, commentRange.startLine, commentRange.endLine);
  return true;
}

function addInlineCommentAtCursor() {
  const side = getFocusedDiffSide();
  const editor = getEditorForSide(side);
  if (!editor) return false;
  const selection = editor.getSelection();
  const position = editor.getPosition();
  const startLine = selection ? selection.startLineNumber : position?.lineNumber;
  const endLine = selection ? selection.endLineNumber : position?.lineNumber;
  if (!startLine || !endLine) return false;
  return addInlineComment(side, startLine, endLine);
}

function createGlyphHoverActions(editor, side) {
  let hoverDecoration = [];

  function openDraftAtLine(line) {
    if (toggleInlineGithubThreadAtLine(side, line)) return;
    if (toggleInlineFindingAtLine(side, line)) return;
    if (toggleInlineCommentAtLine(side, line)) return;
    addInlineComment(side, line, line);
  }

  editor.onMouseMove((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
      return;
    }

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      if (findInlineGithubThreadAtLine(side, line) || findInlineCommentAtLine(side, line) || findInlineFindingAtLine(side, line)) {
        hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
        return;
      }
      hoverDecoration = editor.deltaDecorations(hoverDecoration, [{
        range: new monacoApi.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "review-glyph-plus" },
      }]);
    } else {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
    }
  });

  editor.onMouseLeave(() => {
    hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
  });

  editor.onMouseDown((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return;

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      openDraftAtLine(line);
    }
  });
}

window.__reviewReceive = function (message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "github-context-result") {
    if (message.requestId !== state.githubContextRequestId) return;
    state.githubContextRequestId = null;
    if (message.ok) {
      state.githubContext = message.context;
      state.githubContextStatus = "ready";
      state.githubContextMessage = "";
    } else {
      if (message.cachedContext) state.githubContext = message.cachedContext;
      state.githubContextStatus = "failed";
      state.githubContextMessage = message.message || "GitHub review context could not be loaded.";
    }
    updateGithubThreadCount();
    syncViewZones();
    updateDecorations();
    if (isPrContextOpen()) renderPrContext();
    return;
  }

  if (message.type === "save-session-result") {
    if (message.requestId !== latestSaveRequestId) return;
    if (message.ok) {
      const savedAt = message.savedAt ? new Date(message.savedAt) : null;
      const detail = savedAt && !Number.isNaN(savedAt.getTime()) ? `Saved at ${savedAt.toLocaleTimeString()}` : "Saved";
      setAutosaveStatus("saved", "Saved", detail);
    } else if (message.retryable === false) {
      setAutosaveStatus("blocked", "Reopen required", message.message || "This review changed in another window.");
    } else {
      setAutosaveStatus("failed", "Save failed", message.message || "Click to retry autosave.");
    }
    return;
  }

  if (message.type === "publish-github-review-result") {
    handlePublishGitHubReviewResult(message);
    return;
  }

  if (message.type === "review-map-progress") {
    state.reviewMapProgress = message.progress || null;
    renderTree();
    return;
  }

  if (message.type === "review-map-result") {
    const activeFileId = state.activeFileId;
    const reconciled = reconcileReviewMapState(reviewData.map, message.map, {
      reviewedVisits: state.reviewedVisits,
      activeVisitId: state.activeVisitId,
      activeFileId,
    });
    reviewData.map = message.map;
    reviewData.analysis = {
      ...reviewData.analysis,
      chapters: message.map?.chapters || [],
      coverage: message.map?.coverage || reviewData.analysis?.coverage,
    };
    state.reviewMapProgress = {
      phase: message.map?.status === "fallback" ? "failed" : "done",
      message: message.map?.diagnostics?.at(-1) || "Review plan ready.",
    };
    state.reviewedVisits = reconciled.reviewedVisits;
    state.activeVisitId = reconciled.activeVisitId;
    if (activeFileId && reviewData.files.some((file) => file.id === activeFileId)) state.activeFileId = activeFileId;
    renderAll({ restoreFileScroll: true });
    maybeStartAiReview();
    return;
  }

  if (message.type === "ai-review-progress") {
    if (message.requestId !== state.aiReview.requestId) return;
    state.aiReview = {
      requestId: message.requestId,
      status: message.progress?.status || "running",
      message: message.progress?.message || "AI review is running.",
      progress: message.progress,
      config: message.progress?.config || state.aiReview.config,
    };
    renderTree();
    return;
  }

  if (message.type === "ai-review-partial-result") {
    if (message.requestId !== state.aiReview.requestId) return;
    applyAiReviewAnalysis(message.analysis);
    state.aiReview = {
      requestId: message.requestId,
      status: message.progress?.status || "running",
      message: message.progress?.message || "AI review results are streaming.",
      progress: message.progress,
      config: message.progress?.config || state.aiReview.config,
    };
    renderTree();
    syncViewZones();
    updateDecorations();
    renderFileComments();
    return;
  }

  if (message.type === "ai-review-result") {
    if (message.requestId !== state.aiReview.requestId) return;
    applyAiReviewAnalysis(message.analysis);
    state.aiReviewCompleted = ["done", "failed"].includes(message.progress?.status || "done");
    state.aiReview = {
      requestId: message.requestId,
      status: message.progress?.status || "done",
      message: message.progress?.message || "AI review complete.",
      progress: message.progress,
      config: message.progress?.config || state.aiReview.config,
    };
    renderAll({ preserveScroll: true });
    return;
  }

  if (message.type === "ai-review-error") {
    if (message.requestId !== state.aiReview.requestId) return;
    state.aiReviewCompleted = true;
    state.aiReview = {
      requestId: message.requestId,
      status: "failed",
      message: message.message || "AI review failed.",
      progress: message.progress || state.aiReview.progress,
      config: message.progress?.config || state.aiReview.config,
    };
    renderTree();
    return;
  }

  const previousSelectedCommitSha = state.selectedCommitSha;
  if (message.scope === "commit" && message.commitSha) state.selectedCommitSha = message.commitSha;
  const key = cacheKey(message.scope, message.fileId);
  state.selectedCommitSha = previousSelectedCommitSha;

  if (message.type === "file-data") {
    state.fileContents[key] = {
      originalContent: message.originalContent,
      modifiedContent: message.modifiedContent,
    };
    delete state.fileErrors[key];
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope && (message.scope !== "commit" || message.commitSha === state.selectedCommitSha)) {
      mountFile({ restoreFileScroll: true });
    }
    return;
  }

  if (message.type === "file-error") {
    state.fileErrors[key] = message.message || "Unknown error";
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope && (message.scope !== "commit" || message.commitSha === state.selectedCommitSha)) {
      mountFile({ preserveScroll: false });
    }
  }
};

function setupMonaco() {
    monacoApi = monaco;

    monacoApi.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "diffEditor.insertedLineBackground": "#2ea04314",
        "diffEditor.removedLineBackground": "#f8514914",
        "diffEditor.insertedTextBackground": "#2ea04320",
        "diffEditor.removedTextBackground": "#f8514920",
      },
    });
    monacoApi.editor.setTheme("review-dark");

    diffEditor = monacoApi.editor.createDiffEditor(editorContainerEl, {
      automaticLayout: true,
      renderSideBySide: activeFileShowsDiff() && !shouldRenderUnifiedForFile(),
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
      renderOverviewRuler: true,
      diffWordWrap: "on",
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 10,
      overviewRulerBorder: false,
      wordWrap: "on",
    });

    createGlyphHoverActions(diffEditor.getOriginalEditor(), "original");
    createGlyphHoverActions(diffEditor.getModifiedEditor(), "modified");
    trackEditorCursor(diffEditor.getOriginalEditor(), "original");
    trackEditorCursor(diffEditor.getModifiedEditor(), "modified");

    if (typeof ResizeObserver !== "undefined") {
      editorResizeObserver = new ResizeObserver(() => {
        layoutEditor();
      });
      editorResizeObserver.observe(editorContainerEl);
    }

    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
      setTimeout(layoutEditor, 150);
    });

    mountFile();
}

function populateCommitSelect() {
  commitSelectEl.innerHTML = "";
  (reviewData.commits || []).forEach((commit) => {
    const option = document.createElement("option");
    option.value = commit.sha;
    option.textContent = `${commit.shortSha} ${commit.subject}`;
    commitSelectEl.appendChild(option);
  });
  if (state.selectedCommitSha) commitSelectEl.value = state.selectedCommitSha;
}

function switchScope(scope) {
  const hasScopeFiles = {
    "git-diff": reviewData.files.some((file) => file.inGitDiff),
    "last-commit": reviewData.files.some((file) => file.inLastCommit),
    "commit": !!state.selectedCommitSha && reviewData.files.some((file) => file.commitComparisons?.[state.selectedCommitSha]),
    "all-files": reviewData.files.some((file) => file.hasWorkingTreeFile),
  };
  if (!hasScopeFiles[scope] || state.currentScope === scope) return;
  saveCurrentScrollPosition();
  state.currentScope = scope;
  renderAll({ restoreFileScroll: true });
  const file = activeFile();
  if (file) ensureFileLoaded(file.id, state.currentScope);
}

function applyAiReviewAnalysis(analysis) {
  const previousStatuses = state.findingStatuses;
  const previousAcceptedComments = state.acceptedFindingComments;
  reviewData.analysis = analysis;

  const findingIds = new Set((analysis.findings || []).map((finding) => finding.id));
  state.findingStatuses = Object.fromEntries((analysis.findings || []).map((finding) => [
    finding.id,
    previousStatuses[finding.id] || finding.status || "new",
  ]));
  state.acceptedFindingComments = Object.fromEntries(
    Object.entries(previousAcceptedComments).filter(([findingId]) => findingIds.has(findingId)),
  );
  state.collapsedFindingIds = new Set([...state.collapsedFindingIds].filter((findingId) => findingIds.has(findingId)));
  state.dismissedFindingLocationKeys = new Set([...state.dismissedFindingLocationKeys].filter((key) => findingIds.has(key.split(":")[0])));

  if (state.activeInsight.type === "finding" && !findingIds.has(state.activeInsight.id)) {
    state.activeInsight = { type: "default", id: null };
  }
}

function shouldAutoStartAiReview() {
  return Boolean(canSendRendererMessage())
    && state.aiReview.status === "idle"
    && !state.aiReviewCompleted
    && ["semantic", "semantic-repaired", "fallback"].includes(reviewData.map?.status)
    && state.currentScope !== "all-files"
    && getReviewChapters().length > 0;
}

function maybeStartAiReview() {
  if (!shouldAutoStartAiReview()) return;
  runAiReviewFromUi({ auto: true });
}

function runAiReviewFromUi(options = {}) {
  if (state.aiReview.status === "running") return;
  if (!canSendRendererMessage()) {
    state.aiReview = {
      ...state.aiReview,
      status: "failed",
      message: "AI review is only available inside the review app.",
    };
    renderTree();
    return;
  }
  const requestId = `ai-review:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  state.aiReviewCompleted = false;
  state.aiReview = {
    requestId,
    status: "running",
    message: options.auto ? "Mapping PR..." : "Refreshing AI analysis.",
    progress: {
      status: "running",
      phase: "scout",
      message: options.auto ? "Mapping PR..." : "Refreshing AI analysis.",
      scoutSummary: "",
      config: state.aiReview.config,
      chapters: getReviewChapters().map((chapter) => ({
        chapterId: chapter.id,
        title: chapter.title,
        status: "queued",
        message: "Queued.",
        findingCount: 0,
      })),
    },
  };
  renderTree();
  sendRendererMessage({ type: "run-ai-review", requestId });
}

function buildSubmitPayload() {
  return {
    type: "submit",
    overallComment: state.overallComment.trim(),
    comments: commentEditBuffer.snapshot(state.comments)
      .filter((comment) => commentLifecycleState(comment) !== "published")
      .map((comment) => ({ ...comment, body: comment.body.trim() }))
      .filter((comment) => comment.body.length > 0),
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

function finishReview() {
  syncCommentBodiesFromDOM();
  saveSessionNow();
  sendRendererMessage(buildSubmitPayload());
}

function submitReview() {
  if (reviewData.source?.canPublishGitHubReview) {
    showPublishGitHubModal();
    return;
  }
  finishReview();
}

function toggleChangedAreasOnly() {
  if (!activeFileShowsDiff()) return;
  state.hideUnchanged = !state.hideUnchanged;
  applyEditorOptions();
  updateToggleButtons();
  scheduleSessionSave();
  requestAnimationFrame(layoutEditor);
}

function toggleWrapLines() {
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateToggleButtons();
  scheduleSessionSave();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
}

function toggleCurrentFileReviewed() {
  const file = activeFile();
  if (!file) return;
  const activeVisit = visitsForFile(file.id).find((visit) => visit.id === state.activeVisitId) || null;
  if (activeVisit) {
    state.reviewedVisits[activeVisit.id] = state.reviewedVisits[activeVisit.id] !== true;
    state.reviewedFiles[file.id] = isFileReviewed(file.id);
    const chapter = getReviewChapters().find((item) => (item.visits || []).some((visit) => visit.id === activeVisit.id));
    if (chapter) state.reviewedChapters[chapter.id] = isChapterReviewed(chapter);
    if (state.reviewedVisits[activeVisit.id] === true) {
      const next = nextReviewVisit(reviewData.map, state.reviewedVisits, activeVisit.id, 1);
      if (next && next.id !== activeVisit.id) {
        state.activeVisitId = next.id;
        openFile(next.fileId);
        return;
      }
    }
    renderTree();
    scheduleSessionSave();
    return;
  }
  const nextReviewed = !isFileReviewed(file.id);
  state.reviewedFiles[file.id] = nextReviewed;
  visitsForFile(file.id).forEach((visit) => {
    state.reviewedVisits[visit.id] = nextReviewed;
  });
  const chapter = chapterForFile(file.id);
  if (chapter) {
    state.reviewedChapters[chapter.id] = isChapterReviewed(chapter);
  }
  if (nextReviewed && advanceToNextUnreviewedFile(file.id)) {
    return;
  }
  renderTree();
}

function moveReviewVisit(direction) {
  const visit = nextReviewVisit(reviewData.map, state.reviewedVisits, state.activeVisitId, direction);
  if (!visit) {
    moveFile(direction);
    return;
  }
  state.activeVisitId = visit.id;
  openFile(visit.fileId);
}

function toggleCurrentChapterReviewed() {
  const chapters = getReviewChapters();
  const chapter = chapters[getCurrentChapterIndex()];
  if (!chapter) return;
  const files = getChapterDisplayFiles(chapter);
  const markReviewed = !isChapterReviewed(chapter);
  files.forEach((file) => {
    state.reviewedFiles[file.id] = markReviewed;
  });
  (chapter.visits || []).forEach((visit) => {
    state.reviewedVisits[visit.id] = markReviewed;
  });
  state.reviewedChapters[chapter.id] = markReviewed;
  state.activeInsight = { type: "chapter", id: chapter.id };
  if (markReviewed && advanceToNextUnreviewedFile(state.activeFileId)) {
    return;
  }
  renderTree();
}

function focusSidebarPane() {
  if (state.sidebarCollapsed) {
    state.sidebarCollapsed = false;
    updateSidebarLayout();
  }
  sidebarEl.focus();
  setTimeout(() => {
    const target = fileTreeEl.querySelector("[aria-current='true'], button") || sidebarSearchInputEl;
    target?.focus();
  }, 0);
}

function focusDiffPane() {
  mainPaneEl.focus();
  const ranges = getReviewableRangesForFile(activeFile());
  if (state.activeDiffLine != null) {
    focusDiffLine(state.activeDiffSide, state.activeDiffLine);
    return;
  }
  if (ranges[0]) {
    focusDiffLine(ranges[0].side, ranges[0].start, ranges[0].end);
    return;
  }
  diffEditor?.getModifiedEditor().focus();
}

function focusInsightPane() {
  if (insightPanelEl.classList.contains("hidden")) {
    submitReview();
    return;
  }
  insightPanelEl.focus();
  setTimeout(() => {
    const target = insightContentEl.querySelector("[aria-current='true'], button, textarea");
    target?.focus();
  }, 0);
}

function focusFileSearch() {
  if (state.sidebarCollapsed) {
    state.sidebarCollapsed = false;
    updateSidebarLayout();
  }
  sidebarSearchInputEl.focus();
  sidebarSearchInputEl.select();
}

function trackEditorCursor(editor, side) {
  editor.onDidChangeCursorPosition((event) => {
    if (!editor.hasTextFocus()) return;
    state.activeDiffSide = side;
    state.activeDiffLine = event.position?.lineNumber ?? null;
    if (state.activeDiffLine != null) updateKeyboardLineDecoration(side, state.activeDiffLine);
  });
}

function isTextEntryTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".review-modal-card")) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.matches("textarea[data-comment-id], #sidebar-search-input, input, select, [contenteditable='true']")) return true;
  return false;
}

function isReviewCanvasTarget(target) {
  if (target === document.body) return true;
  return target instanceof HTMLElement && mainPaneEl.contains(target);
}

function shortcutAction(id, label, shortcut, run, options = {}) {
  return {
    id,
    label,
    shortcut,
    keywords: options.keywords || "",
    enabled: options.enabled || (() => true),
    match: options.match || (() => false),
    run,
  };
}

function getKeyboardActions() {
  const key = (expected, options = {}) => (event) => {
    if (options.metaOrCtrl && !(event.metaKey || event.ctrlKey)) return false;
    if (!options.metaOrCtrl && (event.metaKey || event.ctrlKey || event.altKey)) return false;
    if (!!options.shift !== event.shiftKey) return false;
    return event.key.toLowerCase() === expected.toLowerCase();
  };
  const toggleReviewedKey = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
    return event.key.toLowerCase() === "f" || (event.key === " " && isReviewCanvasTarget(event.target));
  };

  return [
    shortcutAction("help", "Show keyboard shortcuts", "?", showKeyboardShortcutsModal, {
      keywords: "help shortcuts",
      match: (event) => !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "?",
    }),
    shortcutAction("palette", "Open command palette", "Cmd/Ctrl+K", showCommandPalette, {
      keywords: "command palette",
      match: key("k", { metaOrCtrl: true }),
    }),
    shortcutAction("run-ai-review", state.aiReview.status === "running" ? "AI review running" : "Refresh AI analysis", "Cmd/Ctrl+R", () => runAiReviewFromUi({ force: true }), {
      keywords: "ai review findings refresh rerun",
      enabled: () => state.aiReview.status !== "running",
      match: key("r", { metaOrCtrl: true }),
    }),
    shortcutAction("focus-sidebar", "Focus review map or files", "1", focusSidebarPane, { match: key("1") }),
    shortcutAction("focus-diff", "Focus diff", "2", focusDiffPane, { match: key("2") }),
    shortcutAction("focus-context", "Open review checkout", "3", focusInsightPane, { match: key("3") }),
    shortcutAction("search-files", "Search files", "/", focusFileSearch, { match: key("/") }),
    shortcutAction("pr-context", "Open PR context", "P", () => openPrContext("overview"), {
      enabled: () => !!reviewData.source?.github,
      match: key("p"),
    }),
    shortcutAction("next-file", "Next review visit", "]", () => moveReviewVisit(1), { match: key("]") }),
    shortcutAction("previous-file", "Previous review visit", "[", () => moveReviewVisit(-1), { match: key("[") }),
    shortcutAction("scroll-down", "Move diff focus down", "J / ↓", () => moveDiffFocus(1), {
      match: (event) => key("j")(event) || (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "ArrowDown"),
    }),
    shortcutAction("scroll-up", "Move diff focus up", "K / ↑", () => moveDiffFocus(-1), {
      match: (event) => key("k")(event) || (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "ArrowUp"),
    }),
    shortcutAction("comment-line", "Add line comment", "C", addInlineCommentAtCursor, {
      enabled: () => activeFileShowsDiff(),
      match: key("c"),
    }),
    shortcutAction("comment-file", "Add file comment", "Shift+C", showFileCommentModal, { match: key("c", { shift: true }) }),
    shortcutAction("mark-file-reviewed", "Complete review visit and advance", "F / Space", toggleCurrentFileReviewed, { match: toggleReviewedKey }),
    shortcutAction("mark-chapter-reviewed", "Toggle review area files", "Shift+F", toggleCurrentChapterReviewed, { match: key("f", { shift: true }) }),
    shortcutAction("stage-finding", "Stage AI finding", "S", stageCurrentFinding, {
      enabled: () => activeFileShowsDiff(),
      match: key("s"),
    }),
    shortcutAction("dismiss-finding", "Dismiss AI finding", "X / D", dismissCurrentFinding, {
      enabled: () => activeFileShowsDiff(),
      match: (event) => key("x")(event) || key("d")(event),
    }),
    shortcutAction("edit-comment", "Edit staged note", "Enter", editActiveComment, {
      match: (event) => !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "Enter",
    }),
    shortcutAction("toggle-changed-only", "Toggle changed areas only", "U", toggleChangedAreasOnly, {
      enabled: () => activeFileShowsDiff(),
      match: key("u"),
    }),
    shortcutAction("toggle-wrap", "Toggle line wrap", "W", toggleWrapLines, { match: key("w") }),
    shortcutAction("submit-review", "Submit review", "Cmd/Ctrl+Enter", submitReview, { match: key("Enter", { metaOrCtrl: true }) }),
  ];
}

function showKeyboardShortcutsModal() {
  const actions = getKeyboardActions().filter((action) => action.shortcut);
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-1 text-base font-semibold text-white">Keyboard shortcuts</div>
      <div class="mb-4 text-sm text-review-muted">Navigate the review, add comments, and mark progress without leaving the keyboard.</div>
      <div class="grid gap-2 sm:grid-cols-2">
        ${actions.map((action) => `
          <div class="flex items-center justify-between gap-4 rounded-md border border-review-border bg-[#010409] px-3 py-2">
            <span class="text-sm text-review-text">${escapeHtml(action.label)}</span>
            <kbd class="shrink-0 rounded border border-review-border bg-review-panel px-2 py-1 text-[11px] font-semibold text-review-muted">${escapeHtml(action.shortcut)}</kbd>
          </div>
        `).join("")}
      </div>
      <div class="mt-4 flex justify-end">
        <button data-action="close" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector("[data-action='close']").addEventListener("click", close);
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector("[data-action='close']").focus();
}

function showCommandPalette() {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card p-0">
      <div class="border-b border-review-border p-3">
        <input id="command-palette-input" type="text" spellcheck="false" autocomplete="off" placeholder="Run a review command" class="w-full rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none placeholder:text-review-muted focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
      </div>
      <div id="command-palette-list" class="scrollbar-thin max-h-[360px] overflow-auto p-2"></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const input = backdrop.querySelector("#command-palette-input");
  const list = backdrop.querySelector("#command-palette-list");
  let selectedIndex = 0;

  const getVisibleActions = () => {
    const query = input.value.trim().toLowerCase();
    return getKeyboardActions()
      .filter((action) => action.enabled())
      .filter((action) => {
        if (!query) return true;
        return `${action.label} ${action.shortcut} ${action.keywords}`.toLowerCase().includes(query);
      });
  };

  const runAction = (action) => {
    if (!action || !action.enabled()) return;
    backdrop.remove();
    action.run();
  };

  const render = () => {
    const actions = getVisibleActions();
    selectedIndex = Math.max(0, Math.min(selectedIndex, actions.length - 1));
    list.innerHTML = actions.length === 0
      ? `<div class="px-3 py-6 text-center text-sm text-review-muted">No matching commands.</div>`
      : actions.map((action, index) => `
        <button data-action-id="${escapeHtml(action.id)}" class="flex w-full items-center justify-between gap-4 rounded-md px-3 py-2 text-left ${index === selectedIndex ? "bg-[#238636]/15 text-white" : "text-review-text hover:bg-[#21262d]"}">
          <span class="text-sm">${escapeHtml(action.label)}</span>
          ${action.shortcut ? `<kbd class="shrink-0 rounded border border-review-border bg-review-panel px-2 py-1 text-[11px] font-semibold text-review-muted">${escapeHtml(action.shortcut)}</kbd>` : `<span class="text-[11px] text-review-muted">Palette</span>`}
        </button>
      `).join("");
    list.querySelectorAll("[data-action-id]").forEach((button) => {
      button.addEventListener("click", () => runAction(actions.find((action) => action.id === button.getAttribute("data-action-id"))));
    });
  };

  input.addEventListener("input", () => {
    selectedIndex = 0;
    render();
  });
  backdrop.addEventListener("keydown", (event) => {
    const actions = getVisibleActions();
    if (event.key === "Escape") {
      event.preventDefault();
      backdrop.remove();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = Math.min(actions.length - 1, selectedIndex + 1);
      render();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex = Math.max(0, selectedIndex - 1);
      render();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runAction(actions[selectedIndex]);
    }
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) backdrop.remove();
  });
  render();
  input.focus();
}

function handleGlobalShortcut(event) {
  if (isTextEntryTarget(event.target)) return;
  if (document.querySelector(".review-modal-backdrop")) return;
  if (event.key === "Escape" && isCheckoutDrawerOpen()) {
    event.preventDefault();
    closeCheckoutDrawer();
    return;
  }
  const action = getKeyboardActions().find((candidate) => candidate.enabled() && candidate.match(event));
  if (!action) return;
  event.preventDefault();
  action.run();
}

submitButton.addEventListener("click", submitReview);

windowTitleEl.addEventListener("click", () => openPrContext("overview", windowTitleEl));
githubThreadCountButton.addEventListener("click", () => openPrContext("threads", githubThreadCountButton));
prContextCloseButton.addEventListener("click", closePrContext);
prContextRefreshButton.addEventListener("click", refreshGithubContext);
prContextOverviewTab.addEventListener("click", () => {
  state.githubContextTab = "overview";
  renderPrContext();
});
prContextThreadsTab.addEventListener("click", () => {
  state.githubContextTab = "threads";
  renderPrContext();
});
prContextContentEl.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const threadId = target?.closest("[data-github-thread-id]")?.dataset.githubThreadId;
  if (threadId) {
    openGithubThread(threadId);
    return;
  }
  const itemId = target?.closest("[data-context-item-id]")?.dataset.contextItemId;
  if (itemId) {
    if (state.expandedGithubContextItemIds.has(itemId)) state.expandedGithubContextItemIds.delete(itemId);
    else state.expandedGithubContextItemIds.add(itemId);
    renderPrContext();
    return;
  }
  const filter = target?.closest("[data-context-filter]")?.dataset.contextFilter;
  if (filter === "open" || filter === "all") {
    state.githubContextFilter = filter;
    renderPrContext();
    syncViewZones();
    updateDecorations();
    return;
  }
  const external = target?.closest("[data-external-url]")?.dataset.externalUrl;
  const safeUrl = safeExternalUrl(external || "");
  if (safeUrl) sendRendererMessage({ type: "open-external-url", url: safeUrl });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !isPrContextOpen()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closePrContext();
}, true);

autosaveStatusButton?.addEventListener("click", () => {
  if (autosaveStatusButton.dataset.status === "failed") saveSessionNow();
});

window.addEventListener("beforeunload", () => {
  syncCommentBodiesFromDOM();
  sessionSaveScheduler.cancel();
  saveSessionNow({ showStatus: false });
});

fileCommentButton.addEventListener("click", () => {
  showFileCommentModal();
});

toggleUnchangedButton.addEventListener("click", toggleChangedAreasOnly);

toggleWrapButton.addEventListener("click", toggleWrapLines);

toggleReviewedButton.addEventListener("click", toggleCurrentFileReviewed);

tabReviewMapButton.addEventListener("click", () => setSidebarTab("review-map"));

tabFilesButton.addEventListener("click", () => setSidebarTab("files"));

tabFindingsButton.addEventListener("click", () => setSidebarTab("findings"));

scopeDiffButton.addEventListener("click", () => {
  switchScope("git-diff");
});

scopeLastCommitButton.addEventListener("click", () => {
  switchScope("last-commit");
});

scopeCommitButton.addEventListener("click", () => {
  switchScope("commit");
});

scopeAllButton.addEventListener("click", () => {
  switchScope("all-files");
});

toggleSidebarButton.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  updateSidebarLayout();
  scheduleSessionSave();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

sidebarSearchInputEl.addEventListener("input", () => {
  state.fileFilter = sidebarSearchInputEl.value;
  renderTree();
});

sidebarSearchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    sidebarSearchInputEl.value = "";
    state.fileFilter = "";
    renderTree();
  }
});

commitSelectEl.addEventListener("change", () => {
  saveCurrentScrollPosition();
  state.selectedCommitSha = commitSelectEl.value || null;
  if (state.currentScope !== "commit") state.currentScope = "commit";
  state.activeFileId = null;
  renderAll({ restoreFileScroll: true });
  const file = activeFile();
  if (file) ensureFileLoaded(file.id, state.currentScope);
});

document.addEventListener("keydown", handleGlobalShortcut);

populateCommitSelect();
ensureActiveFileForScope();
renderTree();
updateGithubThreadCount();
renderFileComments();
updateSidebarLayout();
setupMonaco();
setTimeout(maybeStartAiReview, 250);
if (reviewData.source?.github) setTimeout(refreshGithubContext, 100);
}

window.__reviewBootstrap = function (bootstrap) {
  if (reviewAppStarted || !bootstrap || typeof bootstrap !== "object") return;
  if (bootstrap.protocol !== 1 || typeof bootstrap.sessionId !== "string" || typeof bootstrap.capability !== "string") return;
  reviewAppStarted = true;
  rendererSession = bootstrap;
  sendRendererMessage({ type: "renderer-booted" });
  startReviewApp(bootstrap.data);
};

if (typeof window.glimpse?.send === "function") {
  window.glimpse.send({ type: "renderer-ready" });
}
