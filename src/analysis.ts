import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewDataset } from "./sources/types.js";
import type {
  ApprovalPacket,
  CommentSide,
  ReviewAnalysis,
  ReviewChapter,
  ReviewChapterPriority,
  ReviewChapterRange,
  ReviewCoverageSummary,
  ReviewFinding,
  ReviewFindingKind,
  ReviewFindingSeverity,
  ReviewFindingStatus,
  ReviewLocation,
} from "./types.js";

const ANALYSIS_SYSTEM_PROMPT = `You are a senior code reviewer preparing a review map for a human reviewer.

Return strict JSON only. Do not wrap the response in Markdown. The JSON object must contain exactly these top-level keys:
- "chapters": an array of review chapters
- "findings": an array of findings
- "approvalPacket": a review summary object

Group files into chapters in the order a reviewer should read them. Prefer domain-oriented chapters such as schema and migrations, API surface, service behavior, data models, tests, and miscellaneous changes. Use reviewOrder to encode the suggested review path: put dependencies, high-change core behavior, API/schema contracts, and likely blocker areas before supporting tests, docs, and reference changes. Each chapter must have:
- id: stable kebab-case string
- title: concise human-readable title
- summary: one or two sentences explaining what to review
- reviewOrder: positive integer, where 1 is the first chapter a human should review
- priority: one of "review-first", "high-attention", "standard", "low-attention", "reference"
- attentionTags: short labels explaining what to pay attention to, for example ["Schema", "API", "Tests"]
- fileIds: array of file ids from the input only
- ranges: optional array of changed line ranges when only part of a file belongs to this chapter. Each range must use an input fileId, path, side "original" or "modified", startLine, and endLine. If omitted or empty, the chapter covers all changed ranges in fileIds.
- findingIds: array of finding ids from your findings

Every changed range should have exactly one chapter owner. If a whole file fits one chapter, put its file id in that chapter without ranges. If a file does not fit a specific domain-oriented chapter, put it in a miscellaneous chapter. The review tool will add a final deterministic "Unmapped diff" chapter for any omitted changed ranges so no changed hunks are lost.
If different hunks from the same large file belong to different review areas, repeat that file id across chapters and use non-overlapping ranges so each changed line has exactly one owner.

Separate high-confidence bugs from informational explanations. Only create findings for concrete, actionable review concerns. Do not invent files, file ids, paths, or line numbers. When you are unsure about the exact line, set line to null. Each finding must have:
- id: stable kebab-case string
- kind: one of "bug", "security", "migration-risk", "api-contract", "test-gap", "performance", "question", "informational"
- severity: one of "critical", "high", "medium", "low", "info"
- confidence: one of "critical", "high", "medium", "low", "info"
- title: concise title
- explanation: why this matters
- suggestedComment: a ready-to-post reviewer comment
- locations: array of locations using only input file ids and paths, side one of "original", "modified", "file", and line number or null
- status: "new"

The approvalPacket review summary object must have:
- summary: concise summary of the review scope
- reviewedChapters: array of chapter ids that should be reviewed
- acceptedRisks: array of risks that can be explicitly accepted if no findings remain
- unresolvedFindings: array of finding ids that require action
- suggestedVerdict: one of "comment", "request-changes", "approve"
- body: final review text suitable for the reviewer to edit before submitting

If the input does not contain enough information to identify a concrete bug, keep findings empty and make the review summary summarize the review areas.`;

function chapterIdFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "changes";
}

function inferChapterTitle(path: string): string {
  if (path.includes("migration")) return "Schema and migrations";
  if (path.includes("/tests/") || path.startsWith("tests/")) return "Tests";
  if (path.includes("/api/")) return "API surface";
  if (path.includes("/models/")) return "Data models";
  if (path.includes("/services/")) return "Service behavior";
  return "Miscellaneous changes";
}

function inferChapterPriority(title: string): ReviewChapterPriority {
  if (title === "Schema and migrations" || title === "API surface") return "review-first";
  if (title === "Service behavior" || title === "Data models") return "high-attention";
  if (title === "Miscellaneous changes") return "low-attention";
  return "standard";
}

function inferAttentionTags(title: string): string[] {
  switch (title) {
    case "Schema and migrations":
      return ["Schema", "Migrations"];
    case "API surface":
      return ["API"];
    case "Data models":
      return ["Models"];
    case "Service behavior":
      return ["Services"];
    case "Tests":
      return ["Tests"];
    default:
      return ["Misc"];
  }
}

function inferChapterReviewOrder(title: string): number {
  const normalizedTitle = title.toLowerCase();
  if (normalizedTitle.includes("schema") || normalizedTitle.includes("migration")) return 10;
  if (normalizedTitle.includes("api") || normalizedTitle.includes("contract")) return 20;
  if (normalizedTitle.includes("service") || normalizedTitle.includes("behavior")) return 30;
  if (normalizedTitle.includes("model") || normalizedTitle.includes("data")) return 40;
  if (normalizedTitle.includes("test")) return 50;
  if (normalizedTitle.includes("misc") || normalizedTitle.includes("doc") || normalizedTitle.includes("package")) return 90;
  return 60;
}

function getAnalysisFiles(dataset: ReviewDataset) {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const selectedFiles = dataset.analysisFileIds
    .map((fileId) => fileById.get(fileId))
    .filter((file): file is ReviewDataset["files"][number] => file != null);

  return selectedFiles.length > 0 ? selectedFiles : dataset.files;
}

function countLineRanges(ranges: readonly { start: number; end: number }[] | undefined): number {
  return (ranges ?? []).reduce((total, range) => total + Math.max(0, range.end - range.start + 1), 0);
}

function getFileCoverageRanges(file: ReviewDataset["files"][number]): ReviewChapterRange[] {
  const comparison = file.gitDiff;
  if (comparison == null) return [];
  const path = comparison.newPath ?? comparison.oldPath ?? file.path;
  const originalRanges = (comparison.commentableOriginalLines ?? []).map((range) => ({
    fileId: file.id,
    path,
    side: "original" as const,
    startLine: range.start,
    endLine: range.end,
  }));
  const modifiedRanges = (comparison.commentableModifiedLines ?? []).map((range) => ({
    fileId: file.id,
    path,
    side: "modified" as const,
    startLine: range.start,
    endLine: range.end,
  }));
  return [...originalRanges, ...modifiedRanges];
}

function getFileRangeCounts(file: ReviewDataset["files"][number]): { original: number; modified: number } {
  return {
    original: countLineRanges(file.gitDiff?.commentableOriginalLines),
    modified: countLineRanges(file.gitDiff?.commentableModifiedLines),
  };
}

function getChapterRanges(chapter: ReviewChapter, fileById: Map<string, ReviewDataset["files"][number]>): ReviewChapterRange[] {
  if (chapter.ranges.length > 0) return chapter.ranges;

  return chapter.fileIds.flatMap((fileId) => {
    const file = fileById.get(fileId);
    return file == null ? [] : getFileCoverageRanges(file);
  });
}

function emptyCoverageSummary(): ReviewCoverageSummary {
  return {
    fileCount: 0,
    originalLineCount: 0,
    modifiedLineCount: 0,
    unmappedFileCount: 0,
    unmappedOriginalLineCount: 0,
    unmappedModifiedLineCount: 0,
  };
}

function uniqueChapterId(baseId: string, chapters: readonly ReviewChapter[]): string {
  const existingIds = new Set(chapters.map((chapter) => chapter.id));
  if (!existingIds.has(baseId)) return baseId;

  let index = 2;
  while (existingIds.has(`${baseId}-${index}`)) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

function rangeLineCount(range: ReviewChapterRange): number {
  return Math.max(0, range.endLine - range.startLine + 1);
}

function chapterPrioritySortOrder(priority: ReviewChapterPriority): number {
  switch (priority) {
    case "review-first":
      return 0;
    case "high-attention":
      return 1;
    case "standard":
      return 2;
    case "low-attention":
      return 3;
    case "reference":
      return 4;
  }
}

function chapterPriorityWeight(priority: ReviewChapterPriority): number {
  switch (priority) {
    case "review-first":
      return 100_000;
    case "high-attention":
      return 70_000;
    case "standard":
      return 40_000;
    case "low-attention":
      return 10_000;
    case "reference":
      return 0;
  }
}

function chapterChangedLineCount(chapter: ReviewChapter): number {
  return chapter.ranges.reduce((total, range) => total + rangeLineCount(range), 0);
}

function computeChapterReviewWeight(chapter: ReviewChapter): number {
  const changedLineWeight = Math.min(chapterChangedLineCount(chapter), 50_000);
  const fileWeight = Math.min(new Set(chapter.fileIds).size * 25, 5_000);
  const findingWeight = Math.min(chapter.findingIds.length * 500, 10_000);
  return chapterPriorityWeight(chapter.priority) + changedLineWeight + fileWeight + findingWeight;
}

function isUnmappedChapter(chapter: ReviewChapter): boolean {
  return chapter.id === "unmapped-diff" || chapter.title === "Unmapped diff";
}

function normalizeReviewOrderValue(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function rankReviewChapters(chapters: readonly ReviewChapter[]): ReviewChapter[] {
  return chapters
    .map((chapter, originalIndex) => ({
      chapter,
      originalIndex,
      reviewOrder: normalizeReviewOrderValue(chapter.reviewOrder, originalIndex + 1),
      reviewWeight: computeChapterReviewWeight(chapter),
      priorityOrder: chapterPrioritySortOrder(chapter.priority),
      inferredOrder: inferChapterReviewOrder(chapter.title),
      unmapped: isUnmappedChapter(chapter),
    }))
    .sort((left, right) => {
      if (left.unmapped !== right.unmapped) return left.unmapped ? 1 : -1;
      return left.reviewOrder - right.reviewOrder
        || left.priorityOrder - right.priorityOrder
        || right.reviewWeight - left.reviewWeight
        || left.inferredOrder - right.inferredOrder
        || left.originalIndex - right.originalIndex;
    })
    .map((item, index) => ({
      ...item.chapter,
      reviewOrder: index + 1,
      reviewWeight: item.reviewWeight,
    }));
}

function sameRangeTarget(left: ReviewChapterRange, right: ReviewChapterRange): boolean {
  return left.fileId === right.fileId && left.path === right.path && left.side === right.side;
}

function rangesOverlap(left: ReviewChapterRange, right: ReviewChapterRange): boolean {
  return sameRangeTarget(left, right) && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function rangeContains(container: ReviewChapterRange, range: ReviewChapterRange): boolean {
  return sameRangeTarget(container, range) && container.startLine <= range.startLine && container.endLine >= range.endLine;
}

function subtractRange(base: ReviewChapterRange, assignedRanges: readonly ReviewChapterRange[]): ReviewChapterRange[] {
  let segments = [{ startLine: base.startLine, endLine: base.endLine }];

  for (const assigned of assignedRanges) {
    if (!sameRangeTarget(base, assigned)) continue;
    const nextSegments: typeof segments = [];
    for (const segment of segments) {
      if (assigned.endLine < segment.startLine || assigned.startLine > segment.endLine) {
        nextSegments.push(segment);
        continue;
      }
      if (assigned.startLine > segment.startLine) {
        nextSegments.push({ startLine: segment.startLine, endLine: assigned.startLine - 1 });
      }
      if (assigned.endLine < segment.endLine) {
        nextSegments.push({ startLine: assigned.endLine + 1, endLine: segment.endLine });
      }
    }
    segments = nextSegments;
  }

  return segments.map((segment) => ({
    ...base,
    startLine: segment.startLine,
    endLine: segment.endLine,
  }));
}

function completeDiffCoverage(analysis: ReviewAnalysis, dataset: ReviewDataset): ReviewAnalysis {
  const analysisFiles = getAnalysisFiles(dataset);
  const fileById = new Map(analysisFiles.map((file) => [file.id, file] as const));
  const allRanges = analysisFiles.flatMap(getFileCoverageRanges);
  const chapters = analysis.chapters.map((chapter) => ({
    ...chapter,
    ranges: getChapterRanges(chapter, fileById),
  }));
  const assignedRanges = chapters.flatMap((chapter) => chapter.ranges);
  const unmappedRanges = allRanges.flatMap((range) => subtractRange(range, assignedRanges));
  const unmappedFileIds = [...new Set(unmappedRanges.map((range) => range.fileId))];

  let approvalPacket = analysis.approvalPacket;
  if (unmappedRanges.length > 0) {
    const unmappedChapterId = uniqueChapterId("unmapped-diff", chapters);
    const unmappedChapter: ReviewChapter = {
      id: unmappedChapterId,
      title: "Unmapped diff",
      summary: "Review changed areas that were not assigned to a more specific chapter.",
      reviewOrder: Number.MAX_SAFE_INTEGER,
      reviewWeight: 0,
      priority: "standard",
      attentionTags: ["Unmapped"],
      fileIds: unmappedFileIds,
      ranges: unmappedRanges,
      findingIds: [],
    };
    chapters.push(unmappedChapter);
    approvalPacket = {
      ...approvalPacket,
      reviewedChapters: [...new Set([...approvalPacket.reviewedChapters, unmappedChapterId])],
    };
  }

  const totals = analysisFiles.reduce((counts, file) => {
    const fileCounts = getFileRangeCounts(file);
    counts.original += fileCounts.original;
    counts.modified += fileCounts.modified;
    return counts;
  }, { original: 0, modified: 0 });
  const unmappedTotals = unmappedRanges.reduce((counts, range) => {
    counts[range.side] += rangeLineCount(range);
    return counts;
  }, { original: 0, modified: 0 });

  return {
    ...analysis,
    chapters: rankReviewChapters(chapters),
    approvalPacket,
    coverage: {
      fileCount: analysisFiles.length,
      originalLineCount: totals.original,
      modifiedLineCount: totals.modified,
      unmappedFileCount: unmappedFileIds.length,
      unmappedOriginalLineCount: unmappedTotals.original,
      unmappedModifiedLineCount: unmappedTotals.modified,
    },
  };
}

export function createFallbackAnalysis(dataset: ReviewDataset, message: string): ReviewAnalysis {
  const chaptersByTitle = new Map<string, ReviewChapter>();
  const analysisFiles = getAnalysisFiles(dataset);

  for (const file of analysisFiles) {
    const title = inferChapterTitle(file.path);
    const existing = chaptersByTitle.get(title);
    if (existing) {
      existing.fileIds.push(file.id);
      continue;
    }

    chaptersByTitle.set(title, {
      id: chapterIdFromTitle(title),
      title,
      summary: `Review ${title.toLowerCase()} before marking this source complete.`,
      reviewOrder: inferChapterReviewOrder(title),
      reviewWeight: 0,
      priority: inferChapterPriority(title),
      attentionTags: inferAttentionTags(title),
      fileIds: [file.id],
      ranges: [],
      findingIds: [],
    });
  }

  const chapterTitles = [...chaptersByTitle.values()].map((chapter) => chapter.title);
  const approvalPacket: ApprovalPacket = {
    summary: `${dataset.source.label} contains ${analysisFiles.length} reviewable change file(s).`,
    reviewedChapters: [],
    acceptedRisks: [],
    unresolvedFindings: [],
    suggestedVerdict: "comment",
    body: [`Reviewed ${dataset.source.label}.`, "", "Chapters:", ...chapterTitles.map((title) => `- ${title}`)].join("\n"),
  };

  return completeDiffCoverage({
    status: "fallback",
    message,
    chapters: [...chaptersByTitle.values()],
    findings: [],
    coverage: emptyCoverageSummary(),
    approvalPacket,
  }, dataset);
}

function buildAnalysisInput(dataset: ReviewDataset): string {
  return JSON.stringify({
    source: dataset.source,
    files: getAnalysisFiles(dataset).map((file) => ({
      id: file.id,
      path: file.path,
      status: file.gitDiff?.status ?? file.worktreeStatus,
      displayPath: file.gitDiff?.displayPath ?? file.path,
      inGitDiff: file.inGitDiff,
      inLastCommit: file.inLastCommit,
      changedLineCount: countLineRanges(file.gitDiff?.commentableOriginalLines) + countLineRanges(file.gitDiff?.commentableModifiedLines),
      changedRanges: getFileCoverageRanges(file),
    })),
  });
}

const REVIEW_FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const satisfies readonly ReviewFindingSeverity[];
const REVIEW_CHAPTER_PRIORITIES = ["review-first", "high-attention", "standard", "low-attention", "reference"] as const satisfies readonly ReviewChapterPriority[];
const REVIEW_FINDING_KINDS = [
  "bug",
  "security",
  "migration-risk",
  "api-contract",
  "test-gap",
  "performance",
  "question",
  "informational",
] as const satisfies readonly ReviewFindingKind[];
const REVIEW_FINDING_STATUSES = ["new", "accepted-comment", "dismissed", "accepted-risk"] as const satisfies readonly ReviewFindingStatus[];
const COMMENT_SIDES = ["original", "modified", "file"] as const satisfies readonly CommentSide[];
const SUGGESTED_VERDICTS = ["comment", "request-changes", "approve"] as const satisfies readonly ApprovalPacket["suggestedVerdict"][];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`AI analysis JSON has invalid ${field}.`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`AI analysis JSON has invalid ${field}.`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`AI analysis JSON has invalid ${field}.`);
  }
  return [...value];
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`AI analysis JSON has invalid ${field}.`);
  }
  return value as T;
}

function legacyRiskToPriority(value: unknown): ReviewChapterPriority | null {
  switch (value) {
    case "critical":
    case "high":
      return "review-first";
    case "medium":
      return "standard";
    case "low":
      return "low-attention";
    case "info":
      return "reference";
    default:
      return null;
  }
}

function normalizeChapterPriority(chapter: Record<string, unknown>, index: number): ReviewChapterPriority {
  if (chapter.priority != null) {
    return requireOneOf(chapter.priority, REVIEW_CHAPTER_PRIORITIES, `chapters[${index}].priority`);
  }

  const legacyPriority = legacyRiskToPriority(chapter.risk);
  if (legacyPriority != null) return legacyPriority;

  throw new Error(`AI analysis JSON has invalid chapters[${index}].priority.`);
}

function normalizeAttentionTags(value: unknown, title: string): string[] {
  if (!Array.isArray(value)) return inferAttentionTags(title);

  const tags = value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, 4);

  return tags.length > 0 ? tags : inferAttentionTags(title);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`AI analysis JSON has invalid ${field}.`);
  }
  return value;
}

function normalizeChapterReviewOrder(value: unknown, index: number): number {
  if (value == null) return index + 1;
  return requirePositiveInteger(value, `chapters[${index}].reviewOrder`);
}

function normalizeChapterRange(value: unknown, chapterIndex: number, rangeIndex: number): ReviewChapterRange {
  const range = requireRecord(value, `chapters[${chapterIndex}].ranges[${rangeIndex}]`);
  const startLine = requirePositiveInteger(range.startLine, `chapters[${chapterIndex}].ranges[${rangeIndex}].startLine`);
  const endLine = requirePositiveInteger(range.endLine, `chapters[${chapterIndex}].ranges[${rangeIndex}].endLine`);
  if (endLine < startLine) {
    throw new Error(`AI analysis JSON has invalid chapters[${chapterIndex}].ranges[${rangeIndex}].endLine.`);
  }

  return {
    fileId: requireString(range.fileId, `chapters[${chapterIndex}].ranges[${rangeIndex}].fileId`),
    path: requireString(range.path, `chapters[${chapterIndex}].ranges[${rangeIndex}].path`),
    side: requireOneOf(range.side, ["original", "modified"] as const, `chapters[${chapterIndex}].ranges[${rangeIndex}].side`),
    startLine,
    endLine,
  };
}

function normalizeChapterRanges(value: unknown, chapterIndex: number): ReviewChapterRange[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`AI analysis JSON has invalid chapters[${chapterIndex}].ranges.`);
  }
  return value.map((range, rangeIndex) => normalizeChapterRange(range, chapterIndex, rangeIndex));
}

function normalizeChapter(value: unknown, index: number): ReviewChapter {
  const chapter = requireRecord(value, `chapters[${index}]`);
  const title = requireString(chapter.title, `chapters[${index}].title`);

  return {
    id: requireString(chapter.id, `chapters[${index}].id`),
    title,
    summary: requireString(chapter.summary, `chapters[${index}].summary`),
    reviewOrder: normalizeChapterReviewOrder(chapter.reviewOrder, index),
    reviewWeight: 0,
    priority: normalizeChapterPriority(chapter, index),
    attentionTags: normalizeAttentionTags(chapter.attentionTags, title),
    fileIds: requireStringArray(chapter.fileIds, `chapters[${index}].fileIds`),
    ranges: normalizeChapterRanges(chapter.ranges, index),
    findingIds: requireStringArray(chapter.findingIds, `chapters[${index}].findingIds`),
  };
}

function normalizeLocation(value: unknown, findingIndex: number, locationIndex: number): ReviewLocation {
  const location = requireRecord(value, `findings[${findingIndex}].locations[${locationIndex}]`);
  const line = location.line;
  let normalizedLine: number | null;
  if (line === null) {
    normalizedLine = null;
  } else if (typeof line === "number" && Number.isInteger(line) && line > 0) {
    normalizedLine = line;
  } else {
    throw new Error(`AI analysis JSON has invalid findings[${findingIndex}].locations[${locationIndex}].line.`);
  }

  return {
    fileId: requireString(location.fileId, `findings[${findingIndex}].locations[${locationIndex}].fileId`),
    path: requireString(location.path, `findings[${findingIndex}].locations[${locationIndex}].path`),
    side: requireOneOf(location.side, COMMENT_SIDES, `findings[${findingIndex}].locations[${locationIndex}].side`),
    line: normalizedLine,
  };
}

function normalizeLocations(value: unknown, findingIndex: number): ReviewLocation[] {
  if (!Array.isArray(value)) {
    throw new Error(`AI analysis JSON has invalid findings[${findingIndex}].locations.`);
  }
  return value.map((location, locationIndex) => normalizeLocation(location, findingIndex, locationIndex));
}

function normalizeFinding(value: unknown, index: number): ReviewFinding {
  const finding = requireRecord(value, `findings[${index}]`);
  const status = finding.status ?? "new";

  return {
    id: requireString(finding.id, `findings[${index}].id`),
    kind: requireOneOf(finding.kind, REVIEW_FINDING_KINDS, `findings[${index}].kind`),
    severity: requireOneOf(finding.severity, REVIEW_FINDING_SEVERITIES, `findings[${index}].severity`),
    confidence: requireOneOf(finding.confidence, REVIEW_FINDING_SEVERITIES, `findings[${index}].confidence`),
    title: requireString(finding.title, `findings[${index}].title`),
    explanation: requireString(finding.explanation, `findings[${index}].explanation`),
    suggestedComment: requireString(finding.suggestedComment, `findings[${index}].suggestedComment`),
    locations: normalizeLocations(finding.locations, index),
    status: normalizeAiFindingStatus(status, `findings[${index}].status`),
  };
}

function normalizeAiFindingStatus(value: unknown, field: string): ReviewFindingStatus {
  if (value === "new" || (typeof value === "string" && REVIEW_FINDING_STATUSES.includes(value as ReviewFindingStatus))) {
    return "new";
  }
  throw new Error(`AI analysis JSON has invalid ${field}.`);
}

function normalizeApprovalPacket(value: unknown): ApprovalPacket {
  const packet = requireRecord(value, "approvalPacket");

  return {
    summary: requireString(packet.summary, "approvalPacket.summary"),
    reviewedChapters: requireStringArray(packet.reviewedChapters, "approvalPacket.reviewedChapters"),
    acceptedRisks: requireStringArray(packet.acceptedRisks, "approvalPacket.acceptedRisks"),
    unresolvedFindings: requireStringArray(packet.unresolvedFindings, "approvalPacket.unresolvedFindings"),
    suggestedVerdict: requireOneOf(packet.suggestedVerdict, SUGGESTED_VERDICTS, "approvalPacket.suggestedVerdict"),
    body: requireString(packet.body, "approvalPacket.body"),
  };
}

function requireUniqueIds(values: readonly { id: string }[], field: "chapters" | "findings"): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      throw new Error(`AI analysis JSON has duplicate ${field}[${index}].id.`);
    }
    seen.add(value.id);
  }
}

export function validateAnalysisRelationships(analysis: ReviewAnalysis, dataset: ReviewDataset, requireChangedLineAnchors = false): void {
  const analysisFiles = getAnalysisFiles(dataset);
  const fileById = new Map(analysisFiles.map((file) => [file.id, file] as const));
  const validRanges = analysisFiles.flatMap(getFileCoverageRanges);
  requireUniqueIds(analysis.chapters, "chapters");
  requireUniqueIds(analysis.findings, "findings");

  const findingIds = new Set(analysis.findings.map((finding) => finding.id));
  const chapterIds = new Set(analysis.chapters.map((chapter) => chapter.id));
  const fileOwnerHasExplicitRanges = new Map<string, boolean>();
  const assignedRanges: Array<{ chapterIndex: number; rangeIndex: number; range: ReviewChapterRange }> = [];

  for (const [chapterIndex, chapter] of analysis.chapters.entries()) {
    const hasExplicitRanges = chapter.ranges.length > 0;
    for (const [fileIdIndex, fileId] of chapter.fileIds.entries()) {
      if (!fileById.has(fileId)) {
        throw new Error(`AI analysis JSON references unknown chapters[${chapterIndex}].fileIds[${fileIdIndex}].`);
      }
      const previousOwnerHadExplicitRanges = fileOwnerHasExplicitRanges.get(fileId);
      if (previousOwnerHadExplicitRanges != null && (!previousOwnerHadExplicitRanges || !hasExplicitRanges)) {
        throw new Error(`AI analysis JSON has duplicate chapters[${chapterIndex}].fileIds[${fileIdIndex}].`);
      }
      fileOwnerHasExplicitRanges.set(fileId, hasExplicitRanges);
    }

    for (const [rangeIndex, range] of getChapterRanges(chapter, fileById).entries()) {
      if (!chapter.fileIds.includes(range.fileId)) {
        throw new Error(`AI analysis JSON has invalid chapters[${chapterIndex}].ranges[${rangeIndex}].fileId.`);
      }
      const file = fileById.get(range.fileId);
      if (!file) {
        throw new Error(`AI analysis JSON references unknown chapters[${chapterIndex}].ranges[${rangeIndex}].fileId.`);
      }
      const expectedPaths = new Set(getFileCoverageRanges(file).map((candidate) => candidate.path));
      if (!expectedPaths.has(range.path)) {
        throw new Error(`AI analysis JSON has mismatched chapters[${chapterIndex}].ranges[${rangeIndex}].path.`);
      }
      if (!validRanges.some((candidate) => rangeContains(candidate, range))) {
        throw new Error(`AI analysis JSON has out-of-diff chapters[${chapterIndex}].ranges[${rangeIndex}].`);
      }
      for (const assigned of assignedRanges) {
        if (rangesOverlap(assigned.range, range)) {
          throw new Error(`AI analysis JSON has overlapping chapters[${chapterIndex}].ranges[${rangeIndex}].`);
        }
      }
      assignedRanges.push({ chapterIndex, rangeIndex, range });
    }

    for (const [findingIdIndex, findingId] of chapter.findingIds.entries()) {
      if (!findingIds.has(findingId)) {
        throw new Error(`AI analysis JSON references unknown chapters[${chapterIndex}].findingIds[${findingIdIndex}].`);
      }
    }
  }

  for (const [findingIndex, finding] of analysis.findings.entries()) {
    let hasChangedLineAnchor = false;
    for (const [locationIndex, location] of finding.locations.entries()) {
      const file = fileById.get(location.fileId);
      if (!file) {
        throw new Error(`AI analysis JSON has unknown location for finding ${finding.id}: file ${location.fileId} at findings[${findingIndex}].locations[${locationIndex}].fileId.`);
      }
      if (location.path !== file.path) {
        throw new Error(`AI analysis JSON has mismatched path for finding ${finding.id}: ${location.path} at findings[${findingIndex}].locations[${locationIndex}].path.`);
      }
      if (requireChangedLineAnchors) {
        if (location.side === "file" || location.line == null) continue;
        const isChangedLine = validRanges.some((range) => range.fileId === location.fileId
            && range.path === location.path
            && range.side === location.side
            && location.line! >= range.startLine
            && location.line! <= range.endLine);
        if (!isChangedLine) {
          throw new Error(`AI analysis JSON has non-commentable location for finding ${finding.id}: ${location.side} line ${location.line ?? "null"}.`);
        }
        hasChangedLineAnchor = true;
      }
    }
    if (requireChangedLineAnchors && !hasChangedLineAnchor) {
      throw new Error(`AI analysis JSON finding ${finding.id} has no changed-line anchored location.`);
    }
  }

  for (const [chapterIdIndex, chapterId] of analysis.approvalPacket.reviewedChapters.entries()) {
    if (!chapterIds.has(chapterId)) {
      throw new Error(`AI analysis JSON references unknown approvalPacket.reviewedChapters[${chapterIdIndex}].`);
    }
  }

  for (const [findingIdIndex, findingId] of analysis.approvalPacket.unresolvedFindings.entries()) {
    if (!findingIds.has(findingId)) {
      throw new Error(`AI analysis JSON references unknown approvalPacket.unresolvedFindings[${findingIdIndex}].`);
    }
  }
}

export function parseReviewAnalysisJson(text: string, dataset?: ReviewDataset): ReviewAnalysis {
  const parsed = requireRecord(JSON.parse(text) as unknown, "analysis");
  if (!Array.isArray(parsed.chapters)) {
    throw new Error("AI analysis JSON has invalid chapters.");
  }
  if (!Array.isArray(parsed.findings)) {
    throw new Error("AI analysis JSON has invalid findings.");
  }

  const analysis: ReviewAnalysis = {
    status: "ready",
    message: "AI analysis ready.",
    chapters: rankReviewChapters(parsed.chapters.map(normalizeChapter)),
    findings: parsed.findings.map(normalizeFinding),
    coverage: emptyCoverageSummary(),
    approvalPacket: normalizeApprovalPacket(parsed.approvalPacket),
  };

  if (dataset) {
    validateAnalysisRelationships(analysis, dataset);
    return completeDiffCoverage(analysis, dataset);
  }

  return analysis;
}

export async function analyzeReviewDataset(ctx: ExtensionCommandContext, dataset: ReviewDataset): Promise<ReviewAnalysis> {
  if (!ctx.model) {
    return createFallbackAnalysis(dataset, "No Pi model is selected, so deterministic fallback analysis was used.");
  }

  const model = ctx.model;

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      return createFallbackAnalysis(dataset, auth.ok ? `No API key for ${model.provider}.` : auth.error);
    }

    const userMessage: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: buildAnalysisInput(dataset) }],
    };

    const response = await complete(
      model,
      { systemPrompt: ANALYSIS_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers },
    );

    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (response.stopReason !== "stop" || text.length === 0) {
      return createFallbackAnalysis(dataset, "AI analysis did not complete cleanly, so deterministic fallback analysis was used.");
    }

    return parseReviewAnalysisJson(text, dataset);
  } catch (error) {
    return createFallbackAnalysis(dataset, "AI analysis could not produce a complete review map, so deterministic fallback analysis was used.");
  }
}
