import type { ReviewChangeUnit, ReviewChangeStory, ReviewChapterPriority, ReviewTestEvidence, ReviewVisit, ReviewVisitRole } from "./types.js";
import type { ReviewMapScoutFact } from "./review-map-scout.js";
import type { ReviewDataset } from "./sources/types.js";

export interface ReviewMapPlanChapter {
  id: string;
  title: string;
  objective: string;
  whyItMatters: string;
  priority: ReviewChapterPriority;
  priorityReason: string;
  dependsOn: string[];
  reviewQuestions: string[];
  changeFlow: string[];
  visits: ReviewVisit[];
  testEvidence: ReviewTestEvidence[];
  exitCriteria: string[];
}

export interface ReviewMapPlan {
  story: ReviewChangeStory;
  chapters: ReviewMapPlanChapter[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty.`);
  return value.trim();
}

function texts(value: unknown, label: string, nonEmpty = false): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0) || (nonEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${nonEmpty ? "a non-empty" : "an"} array of strings.`);
  }
  return value.map((item) => item.trim());
}

function parseStory(value: unknown): ReviewChangeStory {
  const story = record(value, "story");
  return {
    intent: text(story.intent, "story intent"),
    behaviorBefore: text(story.behaviorBefore, "behavior before"),
    behaviorAfter: text(story.behaviorAfter, "behavior after"),
    primaryFlows: texts(story.primaryFlows, "primary flows", true),
    removedOrReplacedBehavior: texts(story.removedOrReplacedBehavior, "removed behavior"),
  };
}

const PRIORITIES = new Set<ReviewChapterPriority>(["review-first", "high-attention", "standard", "low-attention", "reference"]);
const ROLES = new Set<ReviewVisitRole>(["start-here", "contract", "implementation", "caller", "integration", "removed-path", "verification", "reference"]);
const GENERIC_TITLE = /^(miscellaneous changes|tests?|service behavior|api surface|all files|changed files)$/i;

export function parseReviewMapPlan(raw: string, units: ReviewChangeUnit[]): ReviewMapPlan {
  const root = record(JSON.parse(raw) as unknown, "review map plan");
  if (!Array.isArray(root.chapters) || root.chapters.length === 0) throw new Error("Review map plan must contain chapters.");
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const chapterIds = new Set<string>();
  const visitIds = new Set<string>();
  const assignedUnitIds = new Set<string>();
  const chapters = root.chapters.map((rawChapter, chapterIndex): ReviewMapPlanChapter => {
    const chapter = record(rawChapter, `chapter ${chapterIndex + 1}`);
    const id = text(chapter.id, "chapter id");
    const title = text(chapter.title, "chapter title");
    if (chapterIds.has(id)) throw new Error(`Duplicate chapter id ${id}.`);
    if (GENERIC_TITLE.test(title)) throw new Error(`Chapter title "${title}" is a generic directory bucket.`);
    if (!PRIORITIES.has(chapter.priority as ReviewChapterPriority)) throw new Error(`Chapter ${id} has an invalid priority.`);
    if (!Array.isArray(chapter.visits) || chapter.visits.length === 0) throw new Error(`Chapter ${id} requires a start visit.`);
    chapterIds.add(id);
    const visits = chapter.visits.map((rawVisit, visitIndex): ReviewVisit => {
      const visit = record(rawVisit, `visit ${visitIndex + 1}`);
      const visitId = text(visit.id, "visit id");
      const fileId = text(visit.fileId, "visit file id");
      const changeUnitIds = texts(visit.changeUnitIds, "visit change units", true);
      if (visitIds.has(visitId)) throw new Error(`Duplicate visit id ${visitId}.`);
      if (!ROLES.has(visit.role as ReviewVisitRole)) throw new Error(`Visit ${visitId} has an invalid role.`);
      for (const unitId of changeUnitIds) {
        const unit = unitById.get(unitId);
        if (unit == null) throw new Error(`Visit ${visitId} references unknown or invented unit ${unitId}.`);
        if (unit.fileId !== fileId) throw new Error(`Visit ${visitId} assigns unit ${unitId} to the wrong file.`);
        if (assignedUnitIds.has(unitId)) throw new Error(`Change unit ${unitId} is assigned more than once.`);
        assignedUnitIds.add(unitId);
      }
      visitIds.add(visitId);
      return {
        id: visitId,
        fileId,
        changeUnitIds,
        role: visit.role as ReviewVisitRole,
        reason: text(visit.reason, "visit reason"),
        focus: texts(visit.focus, "visit focus"),
      };
    });
    const testEvidence = Array.isArray(chapter.testEvidence) ? chapter.testEvidence.map((rawEvidence) => {
      const evidence = record(rawEvidence, "test evidence");
      return {
        visitIds: texts(evidence.visitIds, "test evidence visits"),
        proves: texts(evidence.proves, "test evidence proves"),
        doesNotProve: texts(evidence.doesNotProve, "test evidence gaps"),
      };
    }) : [];
    return {
      id,
      title,
      objective: text(chapter.objective, "chapter objective"),
      whyItMatters: text(chapter.whyItMatters, "chapter rationale"),
      priority: chapter.priority as ReviewChapterPriority,
      priorityReason: text(chapter.priorityReason, "priority reason"),
      dependsOn: texts(chapter.dependsOn, "chapter dependencies"),
      reviewQuestions: texts(chapter.reviewQuestions, "review questions", true),
      changeFlow: texts(chapter.changeFlow, "change flow", true),
      visits,
      testEvidence,
      exitCriteria: texts(chapter.exitCriteria, "exit criteria", true),
    };
  });
  for (const chapter of chapters) {
    if (chapter.dependsOn.some((id) => !chapterIds.has(id))) throw new Error(`Chapter ${chapter.id} depends on an unknown chapter.`);
    if (chapter.testEvidence.some((evidence) => evidence.visitIds.some((id) => !visitIds.has(id)))) throw new Error(`Chapter ${chapter.id} references unknown test evidence visits.`);
  }
  return { story: parseStory(root.story), chapters };
}

export function buildReviewMapPlannerInput(dataset: ReviewDataset, units: ReviewChangeUnit[], facts: ReviewMapScoutFact[]): string {
  return JSON.stringify({
    source: dataset.source,
    commits: dataset.commits,
    units,
    scoutFacts: facts,
    instructions: {
      organizeBy: "end-to-end behavior and reviewer dependency order",
      pairTestsWithBehavior: true,
      allowSplitFileVisits: true,
      requireExactUnitAssignment: true,
    },
  });
}
