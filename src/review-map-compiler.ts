import type { ReviewMapPlan, ReviewMapPlanChapter } from "./review-map-planner.js";
import type { ExactCoverage, ReviewChangeUnit, ReviewMap, ReviewMapStatus, SemanticReviewChapter } from "./types.js";

export class ReviewMapQualityError extends Error {
  readonly diagnostics: string[];

  constructor(message: string, diagnostics: string[] = [message]) {
    super(message);
    this.name = "ReviewMapQualityError";
    this.diagnostics = diagnostics;
  }
}

export class ReviewMapRepairableQualityError extends ReviewMapQualityError {
  constructor(message: string, diagnostics: string[] = [message]) {
    super(message, diagnostics);
    this.name = "ReviewMapRepairableQualityError";
  }
}

export interface CompileReviewMapOptions {
  sourceFingerprint: string;
  strategyVersion: string;
  plan: ReviewMapPlan;
  units: ReviewChangeUnit[];
  status: Extract<ReviewMapStatus, "semantic" | "semantic-repaired" | "fallback">;
}

function rangeWeight(unit: ReviewChangeUnit): number {
  return unit.ranges.reduce((total, range) => total + range.endLine - range.startLine + 1, 0);
}

function coverageKeys(unit: ReviewChangeUnit): string[] {
  return unit.ranges.flatMap((range) => Array.from(
    { length: range.endLine - range.startLine + 1 },
    (_, index) => `${range.fileId}:${range.side}:${range.startLine + index}`,
  ));
}

function validateCanonicalUnits(units: ReviewChangeUnit[]): void {
  const unitIds = new Set<string>();
  const owners = new Map<string, string>();
  for (const unit of units) {
    if (unitIds.has(unit.id)) throw new ReviewMapQualityError(`Duplicate canonical unit ${unit.id}.`);
    unitIds.add(unit.id);
    for (const key of coverageKeys(unit)) {
      const previous = owners.get(key);
      if (previous != null) throw new ReviewMapQualityError(`Canonical change units ${previous} and ${unit.id} overlap at ${key}.`);
      owners.set(key, unit.id);
    }
  }
}

function orderedChapters(chapters: ReviewMapPlanChapter[]): ReviewMapPlanChapter[] {
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: ReviewMapPlanChapter[] = [];
  const visit = (chapter: ReviewMapPlanChapter): void => {
    if (visited.has(chapter.id)) return;
    if (visiting.has(chapter.id)) throw new ReviewMapQualityError(`Review chapter dependency cycle includes ${chapter.id}.`);
    visiting.add(chapter.id);
    for (const dependencyId of chapter.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency == null) throw new ReviewMapQualityError(`Chapter ${chapter.id} depends on unknown chapter ${dependencyId}.`);
      visit(dependency);
    }
    visiting.delete(chapter.id);
    visited.add(chapter.id);
    result.push(chapter);
  };
  chapters.forEach(visit);
  return result;
}

function compileChapter(chapter: ReviewMapPlanChapter, order: number, unitById: ReadonlyMap<string, ReviewChangeUnit>): SemanticReviewChapter {
  const units = chapter.visits.flatMap((visit) => visit.changeUnitIds.map((id) => {
    const unit = unitById.get(id);
    if (unit == null) throw new ReviewMapQualityError(`Chapter ${chapter.id} references unknown unit ${id}.`);
    if (unit.fileId !== visit.fileId) throw new ReviewMapQualityError(`Visit ${visit.id} assigns ${id} to the wrong file.`);
    return unit;
  }));
  return {
    ...chapter,
    summary: chapter.objective,
    reviewOrder: order,
    reviewWeight: Math.max(1, units.reduce((total, unit) => total + rangeWeight(unit), 0)),
    attentionTags: [],
    fileIds: [...new Set(units.map((unit) => unit.fileId))],
    ranges: units.flatMap((unit) => unit.ranges),
    findingIds: [],
  };
}

function supportingChapter(units: ReviewChangeUnit[]): ReviewMapPlanChapter {
  return {
    id: "supporting-unclassified",
    title: "Supporting or unclassified changes",
    objective: "Review changed units that could not be assigned to a semantic behavior flow.",
    whyItMatters: "Exact diff coverage requires these changes to remain visible.",
    priority: "reference",
    priorityReason: "Review after the semantic behavior chapters.",
    dependsOn: [],
    reviewQuestions: ["Does this change belong to an earlier behavior flow?"],
    changeFlow: ["supporting"],
    visits: units.map((unit, index) => ({
      id: `supporting-visit-${index + 1}`,
      fileId: unit.fileId,
      changeUnitIds: [unit.id],
      role: "reference",
      reason: "This unit remains unclassified after semantic planning.",
      focus: unit.symbol == null ? [] : [unit.symbol],
    })),
    testEvidence: [],
    exitCriteria: ["Every supporting unit has been reviewed or reassigned."],
  };
}

function exactCoverage(units: ReviewChangeUnit[], assignedIds: ReadonlySet<string>): ExactCoverage {
  const original = units.flatMap((unit) => unit.ranges).filter((range) => range.side === "original");
  const modified = units.flatMap((unit) => unit.ranges).filter((range) => range.side === "modified");
  const unmapped = units.filter((unit) => !assignedIds.has(unit.id));
  const count = (ranges: typeof original) => ranges.reduce((total, range) => total + range.endLine - range.startLine + 1, 0);
  return {
    fileCount: new Set(units.map((unit) => unit.fileId)).size,
    originalLineCount: count(original),
    modifiedLineCount: count(modified),
    unmappedFileCount: new Set(unmapped.map((unit) => unit.fileId)).size,
    unmappedOriginalLineCount: count(unmapped.flatMap((unit) => unit.ranges).filter((range) => range.side === "original")),
    unmappedModifiedLineCount: count(unmapped.flatMap((unit) => unit.ranges).filter((range) => range.side === "modified")),
    overlappingOriginalLineCount: 0,
    overlappingModifiedLineCount: 0,
  };
}

export function compileReviewMap(options: CompileReviewMapOptions): ReviewMap {
  validateCanonicalUnits(options.units);
  const unitById = new Map(options.units.map((unit) => [unit.id, unit]));
  const assignedIds = new Set<string>();
  for (const chapter of options.plan.chapters) {
    for (const visit of chapter.visits) {
      for (const unitId of visit.changeUnitIds) {
        if (!unitById.has(unitId)) throw new ReviewMapQualityError(`Plan references unknown unit ${unitId}.`);
        if (assignedIds.has(unitId)) throw new ReviewMapQualityError(`Plan assigns unit ${unitId} more than once.`);
        assignedIds.add(unitId);
      }
    }
  }
  const leftovers = options.units.filter((unit) => !assignedIds.has(unit.id));
  if (leftovers.length > 0) {
    const totalWeight = options.units.reduce((total, unit) => total + rangeWeight(unit), 0);
    const supportingWeight = leftovers.reduce((total, unit) => total + rangeWeight(unit), 0);
    const unitShare = leftovers.length / Math.max(1, options.units.length);
    const lineShare = supportingWeight / Math.max(1, totalWeight);
    if (unitShare > 0.2 || lineShare > 0.2) {
      throw new ReviewMapRepairableQualityError(`Supporting changes exceed quality thresholds (${Math.round(unitShare * 100)}% of units, ${Math.round(lineShare * 100)}% of changed lines).`);
    }
  }
  const planChapters = leftovers.length === 0 ? options.plan.chapters : [...options.plan.chapters, supportingChapter(leftovers)];
  const compiledAssignedIds = new Set(options.units.map((unit) => unit.id));
  const chapters = orderedChapters(planChapters).map((chapter, index) => compileChapter(chapter, index + 1, unitById));
  const coverage = exactCoverage(options.units, compiledAssignedIds);
  if (coverage.unmappedOriginalLineCount !== 0 || coverage.unmappedModifiedLineCount !== 0) {
    throw new ReviewMapQualityError("Compiled review map does not cover every changed line.");
  }
  return {
    version: 2,
    status: options.status,
    sourceFingerprint: options.sourceFingerprint,
    strategyVersion: options.strategyVersion,
    story: options.plan.story,
    changeUnits: options.units,
    chapters,
    coverage,
    diagnostics: [],
  };
}
