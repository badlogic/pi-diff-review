import { Type } from "@earendil-works/pi-ai/compat";
import type { ReviewChangeUnit, ReviewChangeStory, ReviewChapterPriority, ReviewTestEvidence, ReviewVisit, ReviewVisitRole } from "./types.js";
import {
  largestFittingJson,
  projectReviewMapUnits,
  REVIEW_MAP_TEXT_LIMITS,
  truncateReviewMapText,
} from "./review-map-model-input.js";
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

export const REVIEW_MAP_PRIORITIES = [
  "review-first",
  "high-attention",
  "standard",
  "low-attention",
  "reference",
] as const satisfies readonly ReviewChapterPriority[];

export const REVIEW_MAP_VISIT_ROLES = [
  "start-here",
  "contract",
  "implementation",
  "caller",
  "integration",
  "removed-path",
  "verification",
  "reference",
] as const satisfies readonly ReviewVisitRole[];

export const REVIEW_MAP_PLANNER_PROMPT = `You design a human review journey for a pull request. Return one strict JSON object and no prose. Organize by end-to-end behavior, not directories or file types, and order chapters by reviewer dependency. Pair tests with the behavior they verify.

The root shape is {"story": Story, "chapters": Chapter[]}. Story contains intent, behaviorBefore, and behaviorAfter as non-empty strings; primaryFlows as a non-empty array of strings; and removedOrReplacedBehavior as an array of strings.

Every Chapter contains id, title, objective, whyItMatters, priority, and priorityReason as non-empty strings; dependsOn, reviewQuestions, changeFlow, and exitCriteria as arrays of strings; visits as a non-empty Visit array; and testEvidence as a TestEvidence array. reviewQuestions, changeFlow, and exitCriteria must be non-empty. Chapter priority must be one of: ${REVIEW_MAP_PRIORITIES.join(", ")}.

Every Visit contains id, fileId, role, and reason as non-empty strings; changeUnitIds as a non-empty array of strings; and focus as an array of strings. Visit role must be one of: ${REVIEW_MAP_VISIT_ROLES.join(", ")}.

Every TestEvidence contains visitIds, proves, and doesNotProve as arrays of strings. Use [] for an empty array; never use null, a scalar string, or an object where an array is required. Assign each supplied unit exactly once, keep each visit's fileId consistent with its units, and reference no invented unit, file, visit, or chapter IDs.

Be compact without dropping identity or coverage: keep each descriptive string within 240 characters and each descriptive array at most 5 items. Combine units from the same file into one visit when they serve the same behavior, but keep separate visits when distinct behavioral slices require separate review.`;

const plannerText = () => Type.String({ minLength: 1, maxLength: 240 });
const plannerTexts = (minItems = 0) => Type.Array(plannerText(), { minItems, maxItems: 5 });
const plannerIds = (minItems = 0) => Type.Array(Type.String({ minLength: 1 }), { minItems, maxItems: 40 });

export const REVIEW_MAP_PLANNER_OUTPUT_SCHEMA = Type.Object({
  story: Type.Object({
    intent: plannerText(),
    behaviorBefore: plannerText(),
    behaviorAfter: plannerText(),
    primaryFlows: plannerTexts(1),
    removedOrReplacedBehavior: plannerTexts(),
  }),
  chapters: Type.Array(Type.Object({
    id: plannerText(),
    title: plannerText(),
    objective: plannerText(),
    whyItMatters: plannerText(),
    priority: Type.Union(REVIEW_MAP_PRIORITIES.map((priority) => Type.Literal(priority))),
    priorityReason: plannerText(),
    dependsOn: plannerIds(),
    reviewQuestions: plannerTexts(1),
    changeFlow: plannerTexts(1),
    visits: Type.Array(Type.Object({
      id: plannerText(),
      fileId: plannerText(),
      role: Type.Union(REVIEW_MAP_VISIT_ROLES.map((role) => Type.Literal(role))),
      reason: plannerText(),
      changeUnitIds: plannerIds(1),
      focus: plannerTexts(),
    }), { minItems: 1, maxItems: 40 }),
    testEvidence: Type.Array(Type.Object({
      visitIds: plannerIds(),
      proves: plannerTexts(),
      doesNotProve: plannerTexts(),
    }), { maxItems: 40 }),
    exitCriteria: plannerTexts(1),
  }), { minItems: 1, maxItems: 40 }),
});

const PRIORITIES = new Set<ReviewChapterPriority>(REVIEW_MAP_PRIORITIES);
const ROLES = new Set<ReviewVisitRole>(REVIEW_MAP_VISIT_ROLES);
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

export interface BuildReviewMapPlannerInputOptions {
  maxInputChars: number;
  repairInstructions?: string;
}

interface PlannerTruncation {
  omittedTextCharacters: number;
  omittedItems: number;
}

function fitRepairInstructions(value: string, maxSerializedChars: number): string {
  const fitted = largestFittingJson({
    maxInputChars: maxSerializedChars,
    maxVariableChars: value.length,
    build: (textCap) => truncateReviewMapText(value, textCap),
  });
  return fitted == null ? "" : JSON.parse(fitted.input) as string;
}

function plannerPayload(
  dataset: ReviewDataset,
  units: ReviewChangeUnit[],
  facts: ReviewMapScoutFact[],
  textCap: number,
  repairInstructions: string | null,
): unknown {
  const truncation: PlannerTruncation = { omittedTextCharacters: 0, omittedItems: 0 };
  const clip = (value: string, hardMax: number): string => {
    const clipped = truncateReviewMapText(value, Math.min(hardMax, textCap));
    truncation.omittedTextCharacters += value.length - clipped.length;
    return clipped;
  };
  const clips = (values: string[]): string[] => {
    const retained = values.slice(0, REVIEW_MAP_TEXT_LIMITS.scoutArrayItems);
    truncation.omittedItems += values.length - retained.length;
    return retained.map((value) => clip(value, REVIEW_MAP_TEXT_LIMITS.scoutText));
  };
  const source = {
    kind: dataset.source.kind,
    label: clip(dataset.source.label, REVIEW_MAP_TEXT_LIMITS.sourceLabel),
    baseRevision: dataset.source.baseRevision,
    headRevision: dataset.source.headRevision,
    ...(dataset.source.github == null ? {} : {
      github: {
        owner: dataset.source.github.owner,
        repo: dataset.source.github.repo,
        number: dataset.source.github.number,
        title: clip(dataset.source.github.title, REVIEW_MAP_TEXT_LIMITS.pullRequestTitle),
        body: clip(dataset.source.github.body, REVIEW_MAP_TEXT_LIMITS.pullRequestBody),
        author: dataset.source.github.author,
        baseRefName: dataset.source.github.baseRefName,
        headRefName: dataset.source.github.headRefName,
        isDraft: dataset.source.github.isDraft,
      },
    }),
  };
  const retainedFacts = facts.slice(0, REVIEW_MAP_TEXT_LIMITS.scoutFacts);
  truncation.omittedItems += facts.length - retainedFacts.length;
  const scoutFacts = retainedFacts.map((fact) => {
    const relationships = fact.candidateRelationships.slice(0, REVIEW_MAP_TEXT_LIMITS.scoutRelationships);
    truncation.omittedItems += fact.candidateRelationships.length - relationships.length;
    return {
      unitIds: fact.unitIds,
      intent: clip(fact.intent, REVIEW_MAP_TEXT_LIMITS.scoutText),
      changedContracts: clips(fact.changedContracts),
      callersAndDependencies: clips(fact.callersAndDependencies),
      removedBehavior: clips(fact.removedBehavior),
      invariants: clips(fact.invariants),
      testEvidence: clips(fact.testEvidence),
      evidenceGaps: clips(fact.evidenceGaps),
      candidateRelationships: relationships.map((relationship) => ({
        fromUnitId: relationship.fromUnitId,
        toUnitId: relationship.toUnitId,
        reason: clip(relationship.reason, REVIEW_MAP_TEXT_LIMITS.scoutText),
      })),
      confidence: fact.confidence,
      unresolvedQuestions: clips(fact.unresolvedQuestions),
    };
  });
  return {
    source,
    commits: dataset.commits.map((commit) => ({
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: clip(commit.subject, REVIEW_MAP_TEXT_LIMITS.commitSubject),
    })),
    units: projectReviewMapUnits(units),
    scoutFacts,
    instructions: {
      organizeBy: "end-to-end behavior and reviewer dependency order",
      pairTestsWithBehavior: true,
      allowSplitFileVisits: true,
      requireExactUnitAssignment: true,
      priorities: REVIEW_MAP_PRIORITIES,
      visitRoles: REVIEW_MAP_VISIT_ROLES,
    },
    repairInstructions,
    truncation,
  };
}

export function buildReviewMapPlannerInput(
  dataset: ReviewDataset,
  units: ReviewChangeUnit[],
  facts: ReviewMapScoutFact[],
  options: BuildReviewMapPlannerInputOptions = { maxInputChars: 500_000 },
): string {
  const repairReserve = Math.min(4_096, Math.floor(options.maxInputChars * 0.1));
  const repairInstructions = options.repairInstructions == null
    ? null
    : fitRepairInstructions(options.repairInstructions, repairReserve);
  const requestLimit = repairInstructions == null
    ? options.maxInputChars - repairReserve
    : options.maxInputChars;
  const fitted = largestFittingJson({
    maxInputChars: requestLimit,
    maxVariableChars: REVIEW_MAP_TEXT_LIMITS.pullRequestBody,
    build: (textCap) => plannerPayload(dataset, units, facts, textCap, repairInstructions),
  });
  if (fitted == null) throw new Error("Planner identity inventory exceeds the configured input budget.");
  return fitted.input;
}
