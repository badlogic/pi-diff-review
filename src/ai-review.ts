import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseReviewAnalysisJson, validateAnalysisRelationships } from "./analysis.js";
import type { ReviewDataset } from "./sources/types.js";
import type {
  AiReviewPhase,
  AiReviewChapterProgress,
  AiReviewProgress,
  AiReviewRuntimeConfig,
  ApprovalPacket,
  ReviewAnalysis,
  ReviewChapter,
  ReviewFile,
  ReviewFinding,
  ReviewLineRange,
  ReviewLocation,
  ReviewFindingSeverity,
} from "./types.js";
import { completeStructuredText } from "./structured-model-completion.js";

const SCOUT_SYSTEM_PROMPT = `You are a PI review scout for a code review cockpit.

Return strict JSON only: {"summary":"..."}.

Summarize the highest-value parallel review strategy from the provided PR metadata, chapter map, and active review skills. Include priority areas, context each chapter agent should care about, and likely test areas. Do not invent bugs. Keep it concise.`;

const CHAPTER_REVIEW_SYSTEM_PROMPT = `You are a PI review subagent reviewing one chapter of a diff.

Return strict JSON only. Do not wrap the response in Markdown. The JSON object must contain exactly these top-level keys:
- "chapters": an array with exactly one chapter object
- "findings": an array of findings
- "approvalPacket": a review summary object

Only create findings for concrete, actionable concerns supported by the provided diff patches. Prefer no finding over a speculative finding. Do not invent files, file ids, paths, or line numbers.

Use the active reviewSkills from the input as the rubric for this chapter. If custom or additional skill instructions are present, apply them only when they are supported by the supplied diff patches. Do not report generic best practices that are not connected to changed lines.

You are reviewing as one subagent in a larger cycle: scout -> chapter agents -> validation critic -> synthesis. Your findings are candidates and must be evidence-backed enough to survive validation.

The chapter object must use the input chapter id, title, summary, reviewOrder, reviewWeight, priority, attentionTags, fileIds, and ranges. Its findingIds must reference only findings you create.

Each finding must have:
- id: stable kebab-case string
- kind: one of "bug", "security", "migration-risk", "api-contract", "test-gap", "performance", "question", "informational"
- severity: one of "critical", "high", "medium", "low", "info"
- confidence: one of "critical", "high", "medium", "low", "info"
- title: concise title
- explanation: why this matters and what evidence in the diff supports it
- suggestedComment: a ready-to-post reviewer comment
- locations: array of locations using only input file ids and paths, side one of "original", "modified", "file", and a changed line number or null when unsure
- status: "new"

The approvalPacket object must summarize this chapter only. If there are no concrete findings, return an empty findings array.`;

const VALIDATION_SYSTEM_PROMPT = `You are the validation critic for a PI diff review cycle.

Return strict JSON only: {"decisions":[...]}.

Return exactly one decision for every input candidate finding id. Do not omit candidate ids, repeat ids, or invent ids.

Each decision must contain:
- id: the candidate finding id
- action: "keep", "drop", or "adjust"
- reason: concise validation reason
- severity: optional corrected severity, one of "critical", "high", "medium", "low", "info"
- confidence: optional corrected confidence, one of "critical", "high", "medium", "low", "info"
- title: optional corrected title
- explanation: optional corrected explanation
- suggestedComment: optional corrected ready-to-post reviewer comment
- locations: optional corrected locations using only exact input file ids and paths, side "original" or "modified", and positive changed-line numbers

Keep only findings that are concrete, actionable, tied to a real changed line or file in the input, and supported by the candidate's own evidence. Drop speculative, duplicate, vague, or unverifiable claims.
Use the supplied changed file patches to verify that each location points at the most relevant changed line for the finding. If the issue is real but the candidate line is imprecise, return action "adjust" with corrected locations.
Every kept or adjusted finding must retain at least one location on a supplied commentable changed line.
Use the active reviewSkills from the input as the validation rubric. Drop findings that do not satisfy at least one enabled skill or that apply a disabled/custom skill without evidence.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are synthesizing a PI diff review after scout, chapter subagents, and validation.

Return strict JSON only:
{
  "summary": "one sentence",
  "suggestedVerdict": "approve" | "comment" | "request-changes",
  "acceptedRisks": ["..."],
  "body": "markdown review summary"
}

The body should be concise, human-reviewer friendly, and grounded in the validated findings. Do not invent issues or claim tests ran unless the input says so.
The input suggestedVerdict is deterministic and must be returned unchanged.`;

interface ChapterReviewResult {
  chapterId: string;
  analysis: ReviewAnalysis;
}

export interface RunAiReviewOptions {
  getFilePatch(file: ReviewFile): Promise<string>;
  onProgress(progress: AiReviewProgress): void;
  onPartialResult?(result: { chapterId: string; analysis: ReviewAnalysis; progress: AiReviewProgress }): void;
  config: AiReviewRuntimeConfig;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} character(s)]`;
}

function reviewSkillsForInput(config: AiReviewRuntimeConfig): Record<string, unknown> {
  return {
    preset: config.skills.preset,
    enabled: config.skills.enabled.map((skill) => ({
      id: skill.id,
      title: skill.title,
      focus: skill.focus,
      instructions: skill.instructions,
    })),
    disabled: config.skills.disabled,
    additionalInstructions: config.skills.additionalInstructions,
  };
}

function emptyProgress(analysis: ReviewAnalysis, config?: AiReviewRuntimeConfig): AiReviewProgress {
  return {
    status: "idle",
    phase: "idle",
    message: "AI review has not run.",
    scoutSummary: "",
    ...(config ? { config: config.public } : {}),
    chapters: analysis.chapters.map((chapter) => ({
      chapterId: chapter.id,
      title: chapter.title,
      status: "queued",
      message: "Queued.",
      findingCount: 0,
    })),
  };
}

function updateChapterProgress(progress: AiReviewProgress, chapterId: string, update: Partial<AiReviewChapterProgress>): AiReviewProgress {
  return {
    ...progress,
    chapters: progress.chapters.map((chapter) => chapter.chapterId === chapterId ? { ...chapter, ...update } : chapter),
  };
}

function completeProgress(progress: AiReviewProgress, status: AiReviewProgress["status"], message: string): AiReviewProgress {
  return {
    ...progress,
    status,
    phase: status === "done" || status === "failed" ? "done" : progress.phase,
    message,
  };
}

export function createValidationFailureResult(analysis: ReviewAnalysis, progress: AiReviewProgress, error: unknown): {
  analysis: ReviewAnalysis;
  progress: AiReviewProgress;
} {
  const detail = error instanceof Error ? error.message : String(error);
  const message = `AI review validation failed: ${detail}`;
  const withoutCandidates = rebuildFindingReferences(analysis, []);
  const failedProgress = refreshProgressFindingCounts(progress, withoutCandidates);
  return {
    analysis: {
      ...withoutCandidates,
      status: "failed",
      message,
      approvalPacket: {
        ...withoutCandidates.approvalPacket,
        summary: "AI review findings are unavailable because validation failed.",
        acceptedRisks: [],
        suggestedVerdict: "comment",
        body: "AI review validation failed before any findings could be accepted.",
      },
    },
    progress: completeProgress({
      ...failedProgress,
      chapters: failedProgress.chapters.map((chapter) => ({
        ...chapter,
        message: "Validation failed; no AI review findings are available.",
      })),
    }, "failed", message),
  };
}

export function refreshProgressFindingCounts(progress: AiReviewProgress, analysis: ReviewAnalysis): AiReviewProgress {
  const countByChapterId = new Map(analysis.chapters.map((chapter) => [chapter.id, chapter.findingIds.length] as const));
  return {
    ...progress,
    chapters: progress.chapters.map((chapter) => ({
      ...chapter,
      findingCount: countByChapterId.get(chapter.chapterId) ?? chapter.findingCount,
    })),
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  if (fenced?.[1]) {
    const parsed = JSON.parse(fenced[1]) as unknown;
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }

  throw new Error("AI review returned malformed JSON.");
}

export function normalizeChapterReviewJson(text: string, chapter: ReviewChapter, maxFindings = Number.POSITIVE_INFINITY): string {
  const parsed = parseJsonObject(text);
  const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).slice(0, maxFindings);
  const findingIds = findings
    .map((finding) => {
      if (finding == null || typeof finding !== "object" || Array.isArray(finding)) return null;
      const id = (finding as { id?: unknown }).id;
      return typeof id === "string" ? id : null;
    })
    .filter((id): id is string => id != null);

  return JSON.stringify({
    chapters: [{
      id: chapter.id,
      title: chapter.title,
      summary: chapter.summary,
      reviewOrder: chapter.reviewOrder,
      reviewWeight: chapter.reviewWeight,
      priority: chapter.priority,
      attentionTags: chapter.attentionTags,
      fileIds: chapter.fileIds,
      ranges: chapter.ranges,
      findingIds,
    }],
    findings,
    approvalPacket: {
      summary: `Review ${chapter.title}.`,
      reviewedChapters: [chapter.id],
      acceptedRisks: [],
      unresolvedFindings: findingIds,
      suggestedVerdict: "comment",
      body: `AI review checked ${chapter.title}.`,
    },
  });
}

function buildScoutInput(dataset: ReviewDataset, analysis: ReviewAnalysis, config: AiReviewRuntimeConfig): string {
  return JSON.stringify({
    source: dataset.source,
    reviewDepth: config.depth,
    reviewSkills: reviewSkillsForInput(config),
    maxFindingsPerChapter: config.maxFindingsPerChapter,
    chapters: analysis.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      summary: chapter.summary,
      reviewOrder: chapter.reviewOrder,
      reviewWeight: chapter.reviewWeight,
      priority: chapter.priority,
      attentionTags: chapter.attentionTags,
      fileCount: chapter.fileIds.length,
      changedLines: {
        original: chapter.ranges.filter((range) => range.side === "original").reduce((total, range) => total + range.endLine - range.startLine + 1, 0),
        modified: chapter.ranges.filter((range) => range.side === "modified").reduce((total, range) => total + range.endLine - range.startLine + 1, 0),
      },
    })),
  });
}

async function completeTextJson(ctx: ExtensionCommandContext, config: AiReviewRuntimeConfig, phase: AiReviewPhase, systemPrompt: string, input: string): Promise<string> {
  return await completeStructuredText({
    ctx,
    route: config.phases[phase],
    systemPrompt,
    input,
    phase,
    depth: config.depth,
  });
}

async function runScout(ctx: ExtensionCommandContext, dataset: ReviewDataset, analysis: ReviewAnalysis, config: AiReviewRuntimeConfig): Promise<string> {
  try {
    const text = await completeTextJson(ctx, config, "scout", SCOUT_SYSTEM_PROMPT, buildScoutInput(dataset, analysis, config));
    const parsed = JSON.parse(text) as unknown;
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { summary?: unknown }).summary === "string") {
      return (parsed as { summary: string }).summary;
    }
  } catch {}

  return `Review ${analysis.chapters.length} chapter(s), prioritizing review-first chapters and changed hunks with schema, API, service, and test impact.`;
}

function fileStatus(file: ReviewFile): string | null {
  return file.gitDiff?.status ?? file.worktreeStatus;
}

async function buildChapterReviewInput(options: {
  dataset: ReviewDataset;
  chapter: ReviewChapter;
  files: ReviewFile[];
  getFilePatch(file: ReviewFile): Promise<string>;
  config: AiReviewRuntimeConfig;
  scoutSummary: string;
}): Promise<string> {
  let remainingChars = options.config.maxChapterPatchChars;
  const files = [];

  for (const file of options.files) {
    const rawPatch = await options.getFilePatch(file);
    const patch = truncateText(rawPatch, Math.max(0, Math.min(options.config.maxPatchCharsPerFile, remainingChars)));
    remainingChars -= patch.length;
    files.push({
      id: file.id,
      path: file.path,
      status: fileStatus(file),
      displayPath: file.gitDiff?.displayPath ?? file.path,
      commentableOriginalLines: file.gitDiff?.commentableOriginalLines ?? [],
      commentableModifiedLines: file.gitDiff?.commentableModifiedLines ?? [],
      patch,
    });
    if (remainingChars <= 0) break;
  }

  return JSON.stringify({
    source: options.dataset.source,
    reviewDepth: options.config.depth,
    reviewSkills: reviewSkillsForInput(options.config),
    maxFindings: options.config.maxFindingsPerChapter,
    scoutSummary: options.scoutSummary,
    chapter: {
      id: options.chapter.id,
      title: options.chapter.title,
      summary: options.chapter.summary,
      reviewOrder: options.chapter.reviewOrder,
      reviewWeight: options.chapter.reviewWeight,
      priority: options.chapter.priority,
      attentionTags: options.chapter.attentionTags,
      fileIds: options.chapter.fileIds,
      ranges: options.chapter.ranges,
    },
    files,
  });
}

function datasetForChapter(dataset: ReviewDataset, chapter: ReviewChapter): ReviewDataset {
  return {
    ...dataset,
    analysisFileIds: chapter.fileIds,
  };
}

async function reviewChapter(ctx: ExtensionCommandContext, dataset: ReviewDataset, chapter: ReviewChapter, scoutSummary: string, options: RunAiReviewOptions): Promise<ChapterReviewResult> {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const files = chapter.fileIds.map((fileId) => fileById.get(fileId)).filter((file): file is ReviewFile => file != null);
  const input = await buildChapterReviewInput({ dataset, chapter, files, getFilePatch: options.getFilePatch, config: options.config, scoutSummary });
  const text = await completeTextJson(ctx, options.config, "chapter", CHAPTER_REVIEW_SYSTEM_PROMPT, input);
  return {
    chapterId: chapter.id,
    analysis: parseReviewAnalysisJson(normalizeChapterReviewJson(text, chapter, options.config.maxFindingsPerChapter), datasetForChapter(dataset, chapter)),
  };
}

function lineInRanges(line: number, ranges: ReviewLineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function sanitizeFindingLocations(finding: ReviewFinding, fileById: Map<string, ReviewFile>): ReviewFinding {
  return {
    ...finding,
    locations: finding.locations.map((location) => {
      if (location.side === "file" || location.line == null) return location;
      const file = fileById.get(location.fileId);
      const ranges = location.side === "original"
        ? file?.gitDiff?.commentableOriginalLines ?? []
        : file?.gitDiff?.commentableModifiedLines ?? [];
      if (lineInRanges(location.line, ranges)) return location;
      return { ...location, line: null };
    }),
  };
}

function uniqueFindingId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }

  let index = 2;
  while (usedIds.has(`${baseId}-${index}`)) {
    index += 1;
  }
  const id = `${baseId}-${index}`;
  usedIds.add(id);
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isSeverity(value: unknown): value is ReviewFindingSeverity {
  return value === "critical" || value === "high" || value === "medium" || value === "low" || value === "info";
}

export interface AiReviewValidationDecision {
  id: string;
  action: "keep" | "drop" | "adjust";
  reason: string;
  severity?: ReviewFindingSeverity;
  confidence?: ReviewFindingSeverity;
  title?: string;
  explanation?: string;
  suggestedComment?: string;
  locations?: ReviewLocation[];
}

type ValidationDecisionIdentity = Record<string, unknown> & {
  id: string;
  action: AiReviewValidationDecision["action"];
};

function assertValidationDecisionContract(
  decisions: unknown[],
  findingIds: Set<string>,
): asserts decisions is ValidationDecisionIdentity[] {
  const seenIds = new Set<string>();

  for (const decision of decisions) {
    if (!isRecord(decision)) {
      throw new Error("AI validation returned malformed decision entry.");
    }
    const id = typeof decision.id === "string" ? decision.id : "";
    if (!findingIds.has(id)) {
      throw new Error(`AI validation returned decision for unknown candidate ${id || "<invalid>"}.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`AI validation returned duplicate decision for candidate ${id}.`);
    }
    seenIds.add(id);
    if (decision.action !== "keep" && decision.action !== "drop" && decision.action !== "adjust") {
      throw new Error(`AI validation returned invalid action for candidate ${id}.`);
    }
  }

  const missingIds = [...findingIds].filter((id) => !seenIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(`AI validation is missing decisions for candidate(s): ${missingIds.join(", ")}.`);
  }
}

function normalizeDecisionLocations(value: unknown, candidateId: string): ReviewLocation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`AI validation returned invalid location for candidate ${candidateId}.`);
  }
  const locations: ReviewLocation[] = [];

  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error(`AI validation returned invalid location for candidate ${candidateId}.`);
    }
    if (item.side !== "original" && item.side !== "modified") {
      throw new Error(`AI validation returned invalid location for candidate ${candidateId}.`);
    }
    const fileId = typeof item.fileId === "string" && item.fileId.length > 0 ? item.fileId : null;
    const path = typeof item.path === "string" && item.path.length > 0 ? item.path : null;
    if (!fileId || !path) {
      throw new Error(`AI validation returned invalid location for candidate ${candidateId}.`);
    }
    if (typeof item.line !== "number" || !Number.isInteger(item.line) || item.line <= 0) {
      throw new Error(`AI validation returned invalid location for candidate ${candidateId}.`);
    }
    const line = item.line;
    locations.push({ fileId, path, side: item.side, line });
  }

  return locations;
}

export function normalizeValidationDecisionsJson(text: string, findingIds: Set<string>): AiReviewValidationDecision[] {
  const parsed = parseJsonObject(text);
  if (!Array.isArray(parsed.decisions)) {
    throw new Error("AI validation must return decisions as an array.");
  }
  const decisions = parsed.decisions;
  const normalized: AiReviewValidationDecision[] = [];
  assertValidationDecisionContract(decisions, findingIds);

  for (const decision of decisions) {
    const locations = normalizeDecisionLocations(decision.locations, decision.id);
    normalized.push({
      id: decision.id,
      action: decision.action,
      reason: typeof decision.reason === "string" && decision.reason.trim().length > 0 ? decision.reason.trim() : "Validated by AI review.",
      ...(isSeverity(decision.severity) ? { severity: decision.severity } : {}),
      ...(isSeverity(decision.confidence) ? { confidence: decision.confidence } : {}),
      ...(typeof decision.title === "string" && decision.title.trim().length > 0 ? { title: decision.title.trim() } : {}),
      ...(typeof decision.explanation === "string" && decision.explanation.trim().length > 0 ? { explanation: decision.explanation.trim() } : {}),
      ...(typeof decision.suggestedComment === "string" && decision.suggestedComment.trim().length > 0 ? { suggestedComment: decision.suggestedComment.trim() } : {}),
      ...(locations ? { locations } : {}),
    });
  }

  return normalized;
}

function rebuildFindingReferences(analysis: ReviewAnalysis, findings: ReviewFinding[]): ReviewAnalysis {
  const findingIds = new Set(findings.map((finding) => finding.id));
  const chapters = analysis.chapters.map((chapter) => ({
    ...chapter,
    findingIds: chapter.findingIds.filter((findingId) => findingIds.has(findingId)),
  }));
  const unresolvedFindings = findings.filter((finding) => finding.severity !== "info").map((finding) => finding.id);
  const suggestedVerdict = verdictForFindings(findings);
  return {
    ...analysis,
    chapters,
    findings,
    approvalPacket: {
      ...analysis.approvalPacket,
      unresolvedFindings,
      reviewedChapters: chapters.filter((chapter) => chapter.findingIds.length > 0 || analysis.approvalPacket.reviewedChapters.includes(chapter.id)).map((chapter) => chapter.id),
      suggestedVerdict,
    },
  };
}

function verdictForFindings(findings: ReviewFinding[]): ApprovalPacket["suggestedVerdict"] {
  const unresolvedFindings = findings.filter((finding) => finding.severity !== "info");
  return unresolvedFindings.some((finding) => finding.severity === "critical" || finding.severity === "high")
    ? "request-changes"
    : unresolvedFindings.length > 0
      ? "comment"
      : "approve";
}

function refreshApprovalPacketForFindings(analysis: ReviewAnalysis, scoutSummary: string): ReviewAnalysis {
  const unresolvedFindings = analysis.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.id);
  const body = [
    "## AI review summary",
    scoutSummary,
    "",
    analysis.findings.length === 0
      ? "No concrete AI findings were produced from the changed hunks."
      : analysis.findings.map((finding, index) => `${index + 1}. ${finding.title} (${finding.severity}, ${finding.confidence} confidence)`).join("\n"),
  ].join("\n").trim();

  return {
    ...analysis,
    approvalPacket: {
      ...analysis.approvalPacket,
      summary: analysis.findings.length === 0
        ? "AI review found no concrete issues in changed hunks."
        : `AI review produced ${analysis.findings.length} validated finding(s).`,
      unresolvedFindings,
      suggestedVerdict: verdictForFindings(analysis.findings),
      body,
    },
  };
}

export function applyValidationDecisions(analysis: ReviewAnalysis, decisions: AiReviewValidationDecision[], dataset: ReviewDataset): ReviewAnalysis {
  assertValidationDecisionContract(decisions, new Set(analysis.findings.map((finding) => finding.id)));
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision] as const));
  const findings: ReviewFinding[] = [];

  for (const finding of analysis.findings) {
    const decision = decisionsById.get(finding.id);
    if (decision?.action === "drop") continue;
    findings.push({
      ...finding,
      ...(decision?.severity ? { severity: decision.severity } : {}),
      ...(decision?.confidence ? { confidence: decision.confidence } : {}),
      ...(decision?.title ? { title: decision.title } : {}),
      ...(decision?.explanation ? { explanation: decision.explanation } : {}),
      ...(decision?.suggestedComment ? { suggestedComment: decision.suggestedComment } : {}),
      ...(decision?.locations ? { locations: decision.locations } : {}),
    });
  }

  const validated = rebuildFindingReferences(analysis, findings);
  validateAnalysisRelationships(validated, dataset, true);
  return validated;
}

async function buildValidationInput(
  dataset: ReviewDataset,
  analysis: ReviewAnalysis,
  scoutSummary: string,
  config: AiReviewRuntimeConfig,
  getFilePatch: (file: ReviewFile) => Promise<string>,
): Promise<string> {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const candidateFileIds = new Set<string>();
  for (const finding of analysis.findings) {
    for (const location of finding.locations) {
      candidateFileIds.add(location.fileId);
    }
  }
  const changedFiles = [];
  for (const fileId of candidateFileIds) {
    const file = fileById.get(fileId);
    if (!file) continue;
    const rawPatch = await getFilePatch(file);
    changedFiles.push({
      id: file.id,
      path: file.path,
      status: fileStatus(file),
      displayPath: file.gitDiff?.displayPath ?? file.path,
      commentableOriginalLines: file.gitDiff?.commentableOriginalLines ?? [],
      commentableModifiedLines: file.gitDiff?.commentableModifiedLines ?? [],
      patch: truncateText(rawPatch, Math.min(config.maxPatchCharsPerFile, 18_000)),
    });
  }

  return JSON.stringify({
    source: dataset.source,
    scoutSummary,
    reviewSkills: reviewSkillsForInput(config),
    coverage: analysis.coverage,
    changedFiles,
    chapters: analysis.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      reviewOrder: chapter.reviewOrder,
      reviewWeight: chapter.reviewWeight,
      priority: chapter.priority,
      attentionTags: chapter.attentionTags,
      fileIds: chapter.fileIds,
      ranges: chapter.ranges,
      findingIds: chapter.findingIds,
    })),
    candidateFindings: analysis.findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      severity: finding.severity,
      confidence: finding.confidence,
      title: finding.title,
      explanation: finding.explanation,
      suggestedComment: finding.suggestedComment,
      locations: finding.locations,
    })),
  });
}

async function validateFindings(
  ctx: ExtensionCommandContext,
  dataset: ReviewDataset,
  analysis: ReviewAnalysis,
  scoutSummary: string,
  config: AiReviewRuntimeConfig,
  getFilePatch: (file: ReviewFile) => Promise<string>,
): Promise<ReviewAnalysis> {
  if (analysis.findings.length === 0) return analysis;
  const findingIds = new Set(analysis.findings.map((finding) => finding.id));
  const text = await completeTextJson(ctx, config, "validation", VALIDATION_SYSTEM_PROMPT, await buildValidationInput(dataset, analysis, scoutSummary, config, getFilePatch));
  const decisions = normalizeValidationDecisionsJson(text, findingIds);
  const validated = applyValidationDecisions(analysis, decisions, dataset);
  return refreshApprovalPacketForFindings(validated, scoutSummary);
}

export interface AiReviewSynthesisJson {
  summary: string;
  suggestedVerdict: ApprovalPacket["suggestedVerdict"];
  acceptedRisks: string[];
  body: string;
}

export function normalizeSynthesisJson(text: string, fallback: ApprovalPacket): AiReviewSynthesisJson {
  const parsed = parseJsonObject(text);
  return {
    summary: typeof parsed.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary.trim() : fallback.summary,
    suggestedVerdict: fallback.suggestedVerdict,
    acceptedRisks: Array.isArray(parsed.acceptedRisks) ? parsed.acceptedRisks.filter((risk): risk is string => typeof risk === "string" && risk.trim().length > 0).map((risk) => risk.trim()) : fallback.acceptedRisks,
    body: typeof parsed.body === "string" && parsed.body.trim().length > 0 ? parsed.body.trim() : fallback.body,
  };
}

function buildSynthesisInput(dataset: ReviewDataset, analysis: ReviewAnalysis, scoutSummary: string, failedChapterCount: number, config: AiReviewRuntimeConfig): string {
  return JSON.stringify({
    source: dataset.source,
    reviewDepth: config.depth,
    reviewSkills: reviewSkillsForInput(config),
    scoutSummary,
    failedChapterCount,
    suggestedVerdict: analysis.approvalPacket.suggestedVerdict,
    unresolvedFindingIds: analysis.approvalPacket.unresolvedFindings,
    coverage: analysis.coverage,
    chapters: analysis.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      summary: chapter.summary,
      reviewOrder: chapter.reviewOrder,
      reviewWeight: chapter.reviewWeight,
      priority: chapter.priority,
      attentionTags: chapter.attentionTags,
      fileCount: chapter.fileIds.length,
      ranges: chapter.ranges,
      findingIds: chapter.findingIds,
    })),
    findings: analysis.findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      severity: finding.severity,
      confidence: finding.confidence,
      title: finding.title,
      explanation: finding.explanation,
      suggestedComment: finding.suggestedComment,
      locations: finding.locations,
    })),
  });
}

async function synthesizeReview(ctx: ExtensionCommandContext, dataset: ReviewDataset, analysis: ReviewAnalysis, scoutSummary: string, failedChapterCount: number, config: AiReviewRuntimeConfig): Promise<ReviewAnalysis> {
  const text = await completeTextJson(ctx, config, "synthesis", SYNTHESIS_SYSTEM_PROMPT, buildSynthesisInput(dataset, analysis, scoutSummary, failedChapterCount, config));
  const synthesis = normalizeSynthesisJson(text, analysis.approvalPacket);
  return {
    ...analysis,
    approvalPacket: {
      ...analysis.approvalPacket,
      summary: synthesis.summary,
      acceptedRisks: synthesis.acceptedRisks,
      suggestedVerdict: synthesis.suggestedVerdict,
      body: synthesis.body,
    },
  };
}

function mergeChapterResults(baseAnalysis: ReviewAnalysis, dataset: ReviewDataset, results: ChapterReviewResult[], scoutSummary: string, message?: string): ReviewAnalysis {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const resultByChapterId = new Map(results.map((result) => [result.chapterId, result.analysis] as const));
  const usedFindingIds = new Set<string>();
  const findings: ReviewFinding[] = [];
  const reviewedChapterIds: string[] = [];

  const chapters = baseAnalysis.chapters.map((chapter) => {
    const result = resultByChapterId.get(chapter.id);
    if (!result) return { ...chapter, findingIds: [] };
    reviewedChapterIds.push(chapter.id);

    const findingIds: string[] = [];
    for (const finding of result.findings) {
      const findingId = uniqueFindingId(`${chapter.id}-${finding.id}`, usedFindingIds);
      findings.push(sanitizeFindingLocations({
        ...finding,
        id: findingId,
        status: "new",
      }, fileById));
      findingIds.push(findingId);
    }
    return { ...chapter, findingIds };
  });

  const unresolvedFindings = findings.filter((finding) => finding.severity !== "info").map((finding) => finding.id);
  const suggestedVerdict = verdictForFindings(findings);
  const body = [
    baseAnalysis.approvalPacket.body,
    "",
    "## AI review summary",
    scoutSummary,
    "",
    findings.length === 0
      ? "No concrete AI findings were produced from the changed hunks."
      : findings.map((finding, index) => `${index + 1}. ${finding.title} (${finding.severity}, ${finding.confidence} confidence)`).join("\n"),
  ].join("\n").trim();

  return {
    ...baseAnalysis,
    status: "ready",
    message: message ?? `AI review complete: ${findings.length} finding(s) across ${results.length} review area(s).`,
    chapters,
    findings,
    approvalPacket: {
      ...baseAnalysis.approvalPacket,
      summary: findings.length === 0
        ? `${baseAnalysis.approvalPacket.summary} AI review found no concrete issues in changed hunks.`
        : `${baseAnalysis.approvalPacket.summary} AI review produced ${findings.length} concrete finding(s).`,
      reviewedChapters: reviewedChapterIds,
      unresolvedFindings,
      suggestedVerdict,
      body,
    },
  };
}

export function finalizeAiReviewResult(options: {
  analysis: ReviewAnalysis;
  progress: AiReviewProgress;
  completedChapterCount: number;
  failedChapterCount: number;
  finalNotes: string[];
}): { analysis: ReviewAnalysis; progress: AiReviewProgress } {
  const noteSuffix = options.finalNotes.length > 0 ? ` ${options.finalNotes.join(" ")}` : "";
  if (options.failedChapterCount > 0) {
    const warning = `AI review incomplete: ${options.failedChapterCount} review area(s) failed. Manual review is required for the failed areas before approval.`;
    const analysis: ReviewAnalysis = {
      ...options.analysis,
      status: "failed",
      message: `${warning} ${options.analysis.findings.length} validated finding(s) are available from ${options.completedChapterCount} completed review area(s).${noteSuffix}`,
      approvalPacket: {
        ...options.analysis.approvalPacket,
        summary: `${warning} ${options.analysis.approvalPacket.summary}`,
        suggestedVerdict: options.analysis.approvalPacket.suggestedVerdict === "request-changes"
          ? "request-changes"
          : "comment",
        body: `${options.analysis.approvalPacket.body}\n\n> ${warning}`.trim(),
      },
    };
    const progress = refreshProgressFindingCounts(options.progress, analysis);
    return { analysis, progress: completeProgress(progress, "failed", analysis.message) };
  }

  const analysis: ReviewAnalysis = {
    ...options.analysis,
    message: `AI review complete: ${options.analysis.findings.length} validated finding(s) across ${options.completedChapterCount} review area(s).${noteSuffix}`,
  };
  const progress = refreshProgressFindingCounts(options.progress, analysis);
  return { analysis, progress: completeProgress(progress, "done", analysis.message) };
}

export async function runAiReview(ctx: ExtensionCommandContext, dataset: ReviewDataset, analysis: ReviewAnalysis, options: RunAiReviewOptions): Promise<{ analysis: ReviewAnalysis; progress: AiReviewProgress }> {
  if (!options.config.phases.chapter.model) {
    throw new Error("No Pi model is selected.");
  }

  let progress: AiReviewProgress = {
    ...emptyProgress(analysis, options.config),
    status: "running" as const,
    phase: "scout" as const,
    message: "Preparing AI review.",
  };
  options.onProgress(progress);

  const scoutSummary = await runScout(ctx, dataset, analysis, options.config);
  progress = {
    ...progress,
    phase: "chapter-review",
    message: "AI review is checking changed hunks.",
    scoutSummary,
  };
  options.onProgress(progress);

  const results: ChapterReviewResult[] = [];
  let nextChapterIndex = 0;
  const runNextChapter = async (): Promise<void> => {
    while (nextChapterIndex < analysis.chapters.length) {
      const chapter = analysis.chapters[nextChapterIndex];
      nextChapterIndex += 1;
      if (!chapter) continue;

      progress = updateChapterProgress(progress, chapter.id, {
        status: "running",
        message: "Reviewing changed hunks.",
      });
      options.onProgress(progress);

      try {
        const result = await reviewChapter(ctx, dataset, chapter, scoutSummary, options);
        results.push(result);
        progress = updateChapterProgress(progress, chapter.id, {
          status: "done",
          message: `Done. ${result.analysis.findings.length} finding(s).`,
          findingCount: result.analysis.findings.length,
        });
        options.onProgress(progress);
        const findingCount = results.reduce((total, item) => total + item.analysis.findings.length, 0);
        const partialAnalysis = mergeChapterResults(
          analysis,
          dataset,
          results,
          scoutSummary,
          `AI review running: ${findingCount} candidate finding(s) from ${results.length}/${analysis.chapters.length} review area(s). Validation will refine them.`,
        );
        options.onPartialResult?.({ chapterId: chapter.id, analysis: partialAnalysis, progress });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress = updateChapterProgress(progress, chapter.id, {
          status: "failed",
          message,
        });
        options.onProgress(progress);
      }
    }
  };

  const parallelism = Math.max(1, Math.min(options.config.parallelChapterReviews, analysis.chapters.length));
  await Promise.all(Array.from({ length: parallelism }, () => runNextChapter()));

  const failedChapterCount = progress.chapters.filter((chapter) => chapter.status === "failed").length;
  if (analysis.chapters.length > 0 && failedChapterCount === analysis.chapters.length) {
    const message = "AI review failed for every review area.";
    return {
      analysis: {
        ...analysis,
        status: "failed",
        message,
      },
      progress: completeProgress(progress, "failed", message),
    };
  }

  progress = {
    ...progress,
    phase: "validation",
    message: "Validation critic is checking candidate findings.",
  };
  options.onProgress(progress);

  let nextAnalysis = mergeChapterResults(analysis, dataset, results, scoutSummary);
  const finalNotes: string[] = [];
  try {
    nextAnalysis = await validateFindings(ctx, dataset, nextAnalysis, scoutSummary, options.config, options.getFilePatch);
    progress = {
      ...refreshProgressFindingCounts(progress, nextAnalysis),
      message: `Validation complete: ${nextAnalysis.findings.length} finding(s) kept.`,
    };
    options.onProgress(progress);
  } catch (error) {
    const failure = createValidationFailureResult(nextAnalysis, progress, error);
    options.onProgress(failure.progress);
    return failure;
  }

  progress = {
    ...progress,
    phase: "synthesis",
    message: "Preparing review summary.",
  };
  options.onProgress(progress);

  try {
    nextAnalysis = await synthesizeReview(ctx, dataset, nextAnalysis, scoutSummary, failedChapterCount, options.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalNotes.push(`Synthesis failed: ${message}`);
  }

  return finalizeAiReviewResult({
    analysis: nextAnalysis,
    progress,
    completedChapterCount: results.length,
    failedChapterCount,
    finalNotes,
  });
}

export function createAiReviewFailedProgress(analysis: ReviewAnalysis, message: string, config?: AiReviewRuntimeConfig): AiReviewProgress {
  return completeProgress({
    ...emptyProgress(analysis, config),
    status: "failed",
    phase: "done",
    message,
  }, "failed", message);
}
