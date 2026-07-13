import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ReviewSourceMetadata } from "./sources/types.js";

export type ReviewScope = "git-diff" | "last-commit" | "commit" | "all-files";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewLineRange {
  start: number;
  end: number;
}

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
  addedLines?: number;
  deletedLines?: number;
  commentableOriginalLines?: ReviewLineRange[];
  commentableModifiedLines?: ReviewLineRange[];
}

export interface ReviewCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

export interface ReviewFile {
  id: string;
  path: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
  commitComparisons: Record<string, ReviewFileComparison>;
}

export interface ReviewFileContents {
  originalContent: string;
  modifiedContent: string;
}

export type CommentSide = "original" | "modified" | "file";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  scope: ReviewScope;
  commitSha?: string;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
  body: string;
  status?: "staged" | "published";
  published?: boolean;
  publishedAt?: string;
  githubReviewId?: number;
  githubReviewUrl?: string;
}

export type GitHubReviewPublishIntentStatus = "pending" | "confirmed" | "ambiguous";

export interface GitHubReviewPublishSourceLock {
  sourceKey: string;
  owner: string;
  repo: string;
  pullNumber: number;
  reviewedBaseSha?: string;
  reviewedHeadSha: string;
}

export interface GitHubReviewPublishIntentReceipt {
  reviewId?: number;
  reviewUrl?: string;
  submittedAt?: string;
  warnings: string[];
}

export interface GitHubReviewPublishIntent {
  version: 1;
  status: GitHubReviewPublishIntentStatus;
  correlationId: string;
  source: GitHubReviewPublishSourceLock;
  representedCommentIds: string[];
  submittedComments: DiffReviewComment[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  receipt?: GitHubReviewPublishIntentReceipt;
}

export interface AcceptedFindingComment {
  findingId: string;
  body: string;
}

export interface FindingStatusUpdate {
  findingId: string;
  status: ReviewFindingStatus;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
  acceptedFindings: AcceptedFindingComment[];
  findingStatuses: FindingStatusUpdate[];
  approvalPacket: ApprovalPacket;
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export interface ReviewRequestFilePayload {
  type: "request-file";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  commitSha?: string;
}

export type GitHubReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

export interface ReviewPublishPayload {
  type: "publish-github-review";
  requestId: string;
  event: GitHubReviewEvent;
  body: string;
  submit: ReviewSubmitPayload;
}

export interface ReviewRunAiReviewPayload {
  type: "run-ai-review";
  requestId: string;
}

export interface ReviewRefreshGitHubContextPayload {
  type: "refresh-github-context";
  requestId: string;
}

export interface ReviewOpenExternalUrlPayload {
  type: "open-external-url";
  url: string;
}

export type ReviewSessionRestoreStatus = "new" | "restored" | "stale" | "refreshed";

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

export interface ReviewActiveInsightState {
  type: "default" | "chapter" | "finding" | "comment";
  id: string | null;
}

export interface ReviewSessionSnapshot {
  map?: ReviewMap;
  analysis?: ReviewAnalysis;
  overallComment?: string;
  comments?: DiffReviewComment[];
  acceptedFindingComments?: Record<string, string>;
  findingStatuses?: Record<string, ReviewFindingStatus>;
  reviewedFiles?: Record<string, boolean>;
  reviewedChapters?: Record<string, boolean>;
  reviewedVisits?: Record<string, boolean>;
  activeVisitId?: string | null;
  activeFileId?: string | null;
  activeSidebarTab?: "review-map" | "files" | "findings";
  currentScope?: ReviewScope;
  selectedCommitSha?: string | null;
  activeInsight?: ReviewActiveInsightState;
  hideUnchanged?: boolean;
  wrapLines?: boolean;
  sidebarCollapsed?: boolean;
  aiReviewCompleted?: boolean;
  aiReviewStatus?: AiReviewRunStatus;
  dismissedFindingLocationKeys?: string[];
  githubPublishIntent?: GitHubReviewPublishIntent;
  githubContext?: GitHubReviewContextSnapshot;
  updatedAt?: string;
}

export type ReviewRendererSessionSnapshot = Omit<
  ReviewSessionSnapshot,
  "map" | "analysis" | "githubPublishIntent" | "githubContext"
>;

export interface ReviewCheckpointSessionPayload {
  type: "checkpoint-session";
  snapshot: ReviewRendererSessionSnapshot;
}

export interface ReviewSaveSessionPayload {
  type: "save-session";
  requestId?: string;
  snapshot: ReviewRendererSessionSnapshot;
}

export type ReviewWindowMessage = ReviewSubmitPayload | ReviewCancelPayload | ReviewRequestFilePayload | ReviewPublishPayload | ReviewRunAiReviewPayload | ReviewRefreshGitHubContextPayload | ReviewOpenExternalUrlPayload | ReviewCheckpointSessionPayload | ReviewSaveSessionPayload;

export interface ReviewFileDataMessage {
  type: "file-data";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  commitSha?: string;
  originalContent: string;
  modifiedContent: string;
}

export interface ReviewFileErrorMessage {
  type: "file-error";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  commitSha?: string;
  message: string;
}

export interface ReviewSaveSessionResultMessage {
  type: "save-session-result";
  requestId: string;
  ok: boolean;
  message?: string;
  savedAt?: string;
  retryable?: boolean;
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

export interface ReviewPublishGitHubReviewSuccessMessage {
  type: "publish-github-review-result";
  requestId: string;
  ok: true;
  message: string;
  publishedCommentIds: string[];
  publishedComments: DiffReviewComment[];
  submittedAt: string;
  reviewId?: number;
  reviewUrl?: string;
  warnings: string[];
}

export interface ReviewPublishGitHubReviewFailureMessage {
  type: "publish-github-review-result";
  requestId: string;
  ok: false;
  message: string;
}

export type ReviewPublishGitHubReviewResultMessage =
  | ReviewPublishGitHubReviewSuccessMessage
  | ReviewPublishGitHubReviewFailureMessage;

export type AiReviewRunStatus = "idle" | "running" | "done" | "failed";
export type AiReviewStepStatus = "queued" | "running" | "done" | "failed";
export type AiReviewDepth = "fast" | "standard" | "deep";
export type AiReviewPhase = "scout" | "chapter" | "validation" | "synthesis";
export type ReviewMapModelPhase = "scout" | "planner" | "critic";
export type AiReviewSkillPreset = "minimal" | "balanced" | "security" | "exhaustive";

export interface AiReviewSkillDefinition {
  id: string;
  title: string;
  focus: string;
  instructions: string;
}

export interface AiReviewResolvedSkillsConfig {
  preset: AiReviewSkillPreset;
  enabled: AiReviewSkillDefinition[];
  disabled: string[];
  additionalInstructions: string | null;
}

export interface AiReviewResolvedPhaseConfig {
  model: string | null;
  reasoning: "off" | ThinkingLevel;
}

export interface AiReviewResolvedConfig {
  depth: AiReviewDepth;
  parallelChapterReviews: number;
  maxPatchCharsPerFile: number;
  maxChapterPatchChars: number;
  maxFindingsPerChapter: number;
  configPaths: string[];
  warnings: string[];
  phases: Record<AiReviewPhase, AiReviewResolvedPhaseConfig>;
  mapPhases: Record<ReviewMapModelPhase, AiReviewResolvedPhaseConfig>;
  skills: AiReviewResolvedSkillsConfig;
}

export interface AiReviewRuntimePhaseConfig {
  model: Model<Api> | null;
  reasoning?: ThinkingLevel;
  modelLabel: string;
}

export interface AiReviewRuntimeConfig {
  depth: AiReviewDepth;
  parallelChapterReviews: number;
  maxPatchCharsPerFile: number;
  maxChapterPatchChars: number;
  maxFindingsPerChapter: number;
  phases: Record<AiReviewPhase, AiReviewRuntimePhaseConfig>;
  mapPhases: Record<ReviewMapModelPhase, AiReviewRuntimePhaseConfig>;
  skills: AiReviewResolvedSkillsConfig;
  public: AiReviewResolvedConfig;
}

export interface AiReviewChapterProgress {
  chapterId: string;
  title: string;
  status: AiReviewStepStatus;
  message: string;
  findingCount: number;
}

export interface AiReviewProgress {
  status: AiReviewRunStatus;
  phase: "idle" | AiReviewPhase | "chapter-review" | "done";
  message: string;
  scoutSummary: string;
  chapters: AiReviewChapterProgress[];
  config?: AiReviewResolvedConfig;
}

export interface ReviewAiReviewProgressMessage {
  type: "ai-review-progress";
  requestId: string;
  progress: AiReviewProgress;
}

export interface ReviewAiReviewResultMessage {
  type: "ai-review-result";
  requestId: string;
  analysis: ReviewAnalysis;
  progress: AiReviewProgress;
}

export interface ReviewAiReviewPartialResultMessage {
  type: "ai-review-partial-result";
  requestId: string;
  chapterId: string;
  analysis: ReviewAnalysis;
  progress: AiReviewProgress;
}

export interface ReviewAiReviewErrorMessage {
  type: "ai-review-error";
  requestId: string;
  message: string;
  progress: AiReviewProgress;
}

export type ReviewMapProgressPhase = "scout" | "planner" | "critic" | "compile" | "done" | "failed";

export interface ReviewMapProgress {
  phase: ReviewMapProgressPhase;
  message: string;
}

export interface ReviewMapProgressMessage {
  type: "review-map-progress";
  progress: ReviewMapProgress;
}

export interface ReviewMapResultMessage {
  type: "review-map-result";
  map: ReviewMap;
}

export type ReviewHostMessage = ReviewFileDataMessage | ReviewFileErrorMessage | ReviewSaveSessionResultMessage | ReviewGitHubContextResultMessage | ReviewPublishGitHubReviewResultMessage | ReviewAiReviewProgressMessage | ReviewAiReviewPartialResultMessage | ReviewAiReviewResultMessage | ReviewAiReviewErrorMessage | ReviewMapProgressMessage | ReviewMapResultMessage;

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewFindingKind = "bug" | "security" | "migration-risk" | "api-contract" | "test-gap" | "performance" | "question" | "informational";
export type ReviewFindingStatus = "new" | "accepted-comment" | "dismissed" | "accepted-risk";
export type ReviewChapterPriority = "review-first" | "high-attention" | "standard" | "low-attention" | "reference";

export interface ReviewLocation {
  fileId: string;
  path: string;
  side: CommentSide;
  line: number | null;
}

export interface ReviewChapterRange {
  fileId: string;
  path: string;
  side: Exclude<CommentSide, "file">;
  startLine: number;
  endLine: number;
}

export interface ReviewChapter {
  id: string;
  title: string;
  summary: string;
  reviewOrder: number;
  reviewWeight: number;
  priority: ReviewChapterPriority;
  attentionTags: string[];
  fileIds: string[];
  ranges: ReviewChapterRange[];
  findingIds: string[];
}

export type ReviewMapStatus = "provisional" | "mapping" | "semantic" | "semantic-repaired" | "fallback";
export type ReviewVisitRole = "start-here" | "contract" | "implementation" | "caller" | "integration" | "removed-path" | "verification" | "reference";

export interface ReviewChangeStory {
  intent: string;
  behaviorBefore: string;
  behaviorAfter: string;
  primaryFlows: string[];
  removedOrReplacedBehavior: string[];
}

export interface ReviewChangeUnit {
  id: string;
  fileId: string;
  path: string;
  symbol?: string;
  ranges: ReviewChapterRange[];
  status: ChangeStatus;
  commitIds: string[];
}

export interface ReviewVisit {
  id: string;
  fileId: string;
  changeUnitIds: string[];
  role: ReviewVisitRole;
  reason: string;
  focus: string[];
}

export interface ReviewTestEvidence {
  visitIds: string[];
  proves: string[];
  doesNotProve: string[];
}

export interface SemanticReviewChapter extends ReviewChapter {
  objective: string;
  whyItMatters: string;
  priorityReason: string;
  dependsOn: string[];
  reviewQuestions: string[];
  changeFlow: string[];
  visits: ReviewVisit[];
  testEvidence: ReviewTestEvidence[];
  exitCriteria: string[];
}

export interface ExactCoverage extends ReviewCoverageSummary {
  overlappingOriginalLineCount: number;
  overlappingModifiedLineCount: number;
}

export interface ReviewMap {
  version: 2;
  status: ReviewMapStatus;
  sourceFingerprint: string;
  strategyVersion: string;
  story: ReviewChangeStory;
  changeUnits: ReviewChangeUnit[];
  chapters: SemanticReviewChapter[];
  coverage: ExactCoverage;
  diagnostics: string[];
}

export interface ReviewFinding {
  id: string;
  kind: ReviewFindingKind;
  severity: ReviewFindingSeverity;
  confidence: ReviewFindingSeverity;
  title: string;
  explanation: string;
  suggestedComment: string;
  locations: ReviewLocation[];
  status: ReviewFindingStatus;
}

export interface ApprovalPacket {
  summary: string;
  reviewedChapters: string[];
  acceptedRisks: string[];
  unresolvedFindings: string[];
  suggestedVerdict: "comment" | "request-changes" | "approve";
  body: string;
}

export interface ReviewAnalysis {
  status: "ready" | "fallback" | "failed";
  message: string;
  chapters: ReviewChapter[];
  findings: ReviewFinding[];
  coverage: ReviewCoverageSummary;
  approvalPacket: ApprovalPacket;
}

export interface ReviewCoverageSummary {
  fileCount: number;
  originalLineCount: number;
  modifiedLineCount: number;
  unmappedFileCount: number;
  unmappedOriginalLineCount: number;
  unmappedModifiedLineCount: number;
}

export interface ReviewWindowData {
  repoRoot: string;
  workingRoot: string;
  files: ReviewFile[];
  analysisFileIds: string[];
  commits: ReviewCommit[];
  source: ReviewSourceMetadata;
  map: ReviewMap;
  analysis: ReviewAnalysis;
  aiReviewConfig?: AiReviewResolvedConfig;
  session?: {
    status: ReviewSessionRestoreStatus;
    message: string;
    storagePath: string;
    updatedAt: string | null;
    snapshot: ReviewSessionSnapshot | null;
    publishWarning?: string;
    recoveryPath?: string;
  };
}

export interface ReviewRendererBootstrap {
  protocol: 1;
  sessionId: string;
  capability: string;
  data: ReviewWindowData;
}
