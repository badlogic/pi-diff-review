import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai/compat";
import {
  largestFittingJson,
  projectReviewMapUnits,
  REVIEW_MAP_TEXT_LIMITS,
  sanitizeReviewMapDiagnostic,
  truncateReviewMapText,
} from "./review-map-model-input.js";
import type { ReviewChangeUnit, ReviewFindingSeverity } from "./types.js";

export interface ReviewMapScoutRelationship {
  fromUnitId: string;
  toUnitId: string;
  reason: string;
}

export interface ReviewMapScoutFact {
  unitIds: string[];
  intent: string;
  changedContracts: string[];
  callersAndDependencies: string[];
  removedBehavior: string[];
  invariants: string[];
  testEvidence: string[];
  evidenceGaps: string[];
  candidateRelationships: ReviewMapScoutRelationship[];
  confidence: ReviewFindingSeverity;
  unresolvedQuestions: string[];
}

export interface RunReviewMapScoutsOptions {
  sourceFingerprint: string;
  strategyVersion: string;
  units: ReviewChangeUnit[];
  getPatch: (unit: ReviewChangeUnit) => Promise<string>;
  complete: (input: string) => Promise<string>;
  cache: Map<string, string>;
  maxInputChars: number;
  concurrency: number;
}

export interface ReviewMapScoutResult {
  facts: ReviewMapScoutFact[];
  diagnostics: string[];
}

interface LoadedScoutFileInput {
  fileId: string;
  path: string;
  unitIds: string[];
  fullPatch: string;
}

interface ReviewMapScoutBatch {
  units: ReviewChangeUnit[];
  initialInput: string;
  retryInput: string;
}

export const REVIEW_MAP_SCOUT_PROMPT = `You inspect bounded diff change units for a code-review map. Return strict JSON only with {"facts":[...]}. Each fact must contain unitIds, intent, changedContracts, callersAndDependencies, removedBehavior, invariants, testEvidence, evidenceGaps, candidateRelationships, confidence, and unresolvedQuestions. Return facts, not chapters, findings, or verdicts. Reference only supplied unit IDs. Patches are supplied once per file, and each file entry lists the unit IDs it supports. Be compact: return no more facts than supplied units, at most 4 items in each descriptive array, at most 8 candidate relationships total, and at most 240 characters in each descriptive string.`;

const scoutText = () => Type.String({ minLength: 1, maxLength: 240 });
const scoutTexts = () => Type.Array(scoutText(), { maxItems: 4 });

export const REVIEW_MAP_SCOUT_OUTPUT_SCHEMA = Type.Object({
  facts: Type.Array(Type.Object({
    unitIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 40 }),
    intent: scoutText(),
    changedContracts: scoutTexts(),
    callersAndDependencies: scoutTexts(),
    removedBehavior: scoutTexts(),
    invariants: scoutTexts(),
    testEvidence: scoutTexts(),
    evidenceGaps: scoutTexts(),
    candidateRelationships: Type.Array(Type.Object({
      fromUnitId: Type.String({ minLength: 1 }),
      toUnitId: Type.String({ minLength: 1 }),
      reason: scoutText(),
    }), { maxItems: 8 }),
    confidence: Type.Union([
      Type.Literal("critical"),
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
      Type.Literal("info"),
    ]),
    unresolvedQuestions: scoutTexts(),
  }), { maxItems: 40 }),
});

const SCOUT_RETRY_INSTRUCTIONS = "The previous response failed validation. Return the required JSON object and reference only supplied unit IDs.";

function createConcurrencyLimiter(concurrency: number): <T>(work: () => Promise<T>) => Promise<T> {
  const waiters: Array<() => void> = [];
  let active = 0;
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await work();
    } finally {
      const next = waiters.shift();
      if (next == null) active -= 1;
      else next();
    }
  };
}

function groupsFor(units: ReviewChangeUnit[]): ReviewChangeUnit[][] {
  const pending = [...units].sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  const groups: ReviewChangeUnit[][] = [];
  while (pending.length > 0) {
    const group = [pending.shift()!];
    const commits = new Set(group[0]!.commitIds);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let index = 0; index < pending.length;) {
        const candidate = pending[index]!;
        if (candidate.commitIds.some((id) => commits.has(id))) {
          group.push(candidate);
          candidate.commitIds.forEach((id) => commits.add(id));
          pending.splice(index, 1);
          expanded = true;
        } else {
          index += 1;
        }
      }
    }
    groups.push(group);
  }
  return groups.flatMap((group) => {
    const chunks: ReviewChangeUnit[][] = [];
    for (let index = 0; index < group.length; index += 8) chunks.push(group.slice(index, index + 8));
    return chunks;
  });
}

function cacheKey(options: RunReviewMapScoutsOptions, units: ReviewChangeUnit[]): string {
  return createHash("sha256").update(JSON.stringify({
    fingerprint: options.sourceFingerprint,
    strategy: options.strategyVersion,
    unitIds: units.map((unit) => unit.id).sort(),
  })).digest("hex");
}

function parseFacts(raw: string, allowedUnitIds: ReadonlySet<string>): ReviewMapScoutResult {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Scout response must be an object.");
  const rawFacts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(rawFacts)) throw new Error("Scout response must contain facts.");
  let truncated = rawFacts.length > REVIEW_MAP_TEXT_LIMITS.scoutFacts;
  const boundedText = (value: string): string => {
    if (value.length > REVIEW_MAP_TEXT_LIMITS.scoutText) truncated = true;
    return truncateReviewMapText(value, REVIEW_MAP_TEXT_LIMITS.scoutText);
  };
  const stringArray = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`${label} must contain strings.`);
    }
    if (value.length > REVIEW_MAP_TEXT_LIMITS.scoutArrayItems) truncated = true;
    return value.slice(0, REVIEW_MAP_TEXT_LIMITS.scoutArrayItems).map(boundedText);
  };
  const facts = rawFacts.map((item) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) throw new Error("Scout fact must be an object.");
    const fact = item as Record<string, unknown>;
    if (!Array.isArray(fact.unitIds) || !fact.unitIds.every((id) => typeof id === "string")) {
      throw new Error("Scout fact unit IDs must contain strings.");
    }
    if (fact.unitIds.length > REVIEW_MAP_TEXT_LIMITS.scoutArrayItems) truncated = true;
    const unitIds = fact.unitIds.slice(0, REVIEW_MAP_TEXT_LIMITS.scoutArrayItems);
    const changedContracts = stringArray(fact.changedContracts, "Scout changed contracts");
    const callersAndDependencies = stringArray(fact.callersAndDependencies, "Scout callers and dependencies");
    const removedBehavior = stringArray(fact.removedBehavior, "Scout removed behavior");
    const invariants = stringArray(fact.invariants, "Scout invariants");
    const testEvidence = stringArray(fact.testEvidence, "Scout test evidence");
    const evidenceGaps = stringArray(fact.evidenceGaps, "Scout evidence gaps");
    const unresolvedQuestions = stringArray(fact.unresolvedQuestions, "Scout unresolved questions");
    if (unitIds.length === 0 || fact.unitIds.some((id) => !allowedUnitIds.has(id))) {
      throw new Error("Scout fact references an unknown or invented change unit.");
    }
    if (typeof fact.intent !== "string"
      || !Array.isArray(fact.candidateRelationships)
      || !["critical", "high", "medium", "low", "info"].includes(String(fact.confidence))) {
      throw new Error("Scout fact has an invalid shape.");
    }
    if (fact.candidateRelationships.length > REVIEW_MAP_TEXT_LIMITS.scoutRelationships) truncated = true;
    const candidateRelationships = fact.candidateRelationships.map((relationship) => {
      if (relationship == null || typeof relationship !== "object" || Array.isArray(relationship)) throw new Error("Scout relationship must be an object.");
      const value = relationship as Record<string, unknown>;
      if (typeof value.fromUnitId !== "string" || typeof value.toUnitId !== "string" || typeof value.reason !== "string"
        || !allowedUnitIds.has(value.fromUnitId) || !allowedUnitIds.has(value.toUnitId)) {
        throw new Error("Scout relationship references an unknown or invented change unit.");
      }
      return { fromUnitId: value.fromUnitId, toUnitId: value.toUnitId, reason: boundedText(value.reason) };
    }).slice(0, REVIEW_MAP_TEXT_LIMITS.scoutRelationships);
    return {
      unitIds,
      intent: boundedText(fact.intent),
      changedContracts,
      callersAndDependencies,
      removedBehavior,
      invariants,
      testEvidence,
      evidenceGaps,
      candidateRelationships,
      confidence: fact.confidence as ReviewFindingSeverity,
      unresolvedQuestions,
    };
  });
  return {
    facts: facts.slice(0, REVIEW_MAP_TEXT_LIMITS.scoutFacts),
    diagnostics: truncated ? ["map.scout response truncated to configured fact and text limits"] : [],
  };
}

function groupByFile(units: ReviewChangeUnit[]): ReviewChangeUnit[][] {
  const groups = new Map<string, ReviewChangeUnit[]>();
  for (const unit of units) {
    const fileUnits = groups.get(unit.fileId) ?? [];
    fileUnits.push(unit);
    groups.set(unit.fileId, fileUnits);
  }
  return [...groups.values()];
}

function scoutPayload(
  sourceFingerprint: string,
  units: ReviewChangeUnit[],
  files: LoadedScoutFileInput[],
  patchCap: number,
  repairInstructions: string | null,
): unknown {
  return {
    sourceFingerprint,
    units: projectReviewMapUnits(units),
    files: files.map((file) => ({
      fileId: file.fileId,
      path: file.path,
      unitIds: file.unitIds,
      patch: file.fullPatch.slice(0, patchCap),
      patchTruncated: file.fullPatch.length > patchCap,
    })),
    repairInstructions,
  };
}

async function buildBatches(
  options: RunReviewMapScoutsOptions,
  units: ReviewChangeUnit[],
  loadPatch: (unit: ReviewChangeUnit) => Promise<string>,
): Promise<{ batches: ReviewMapScoutBatch[]; diagnostics: string[] }> {
  const files = await Promise.all(groupByFile(units).map(async (fileUnits): Promise<LoadedScoutFileInput> => ({
    fileId: fileUnits[0]!.fileId,
    path: fileUnits[0]!.path,
    unitIds: fileUnits.map((unit) => unit.id),
    fullPatch: await loadPatch(fileUnits[0]!),
  })));
  const maxPatchChars = files.reduce((maximum, file) => Math.max(maximum, file.fullPatch.length), 0);
  const fitted = largestFittingJson({
    maxInputChars: options.maxInputChars,
    maxVariableChars: maxPatchChars,
    build: (patchCap) => scoutPayload(options.sourceFingerprint, units, files, patchCap, SCOUT_RETRY_INSTRUCTIONS),
  });
  if (fitted != null) {
    return {
      batches: [{
        units,
        initialInput: JSON.stringify(scoutPayload(options.sourceFingerprint, units, files, fitted.variableChars, null)),
        retryInput: fitted.input,
      }],
      diagnostics: [],
    };
  }
  if (units.length === 1) {
    return {
      batches: [],
      diagnostics: [`map.scout unit ${units[0]!.id} fixed metadata exceeds ${options.maxInputChars} characters`],
    };
  }
  const middle = Math.ceil(units.length / 2);
  const [left, right] = await Promise.all([
    buildBatches(options, units.slice(0, middle), loadPatch),
    buildBatches(options, units.slice(middle), loadPatch),
  ]);
  return {
    batches: [...left.batches, ...right.batches],
    diagnostics: [...left.diagnostics, ...right.diagnostics],
  };
}

export async function runReviewMapScouts(options: RunReviewMapScoutsOptions): Promise<ReviewMapScoutResult> {
  const groups = groupsFor(options.units);
  const patchByFileId = new Map<string, Promise<string>>();
  const withPatchPermit = createConcurrencyLimiter(Math.max(1, options.concurrency));
  const loadPatch = (unit: ReviewChangeUnit): Promise<string> => {
    const cached = patchByFileId.get(unit.fileId);
    if (cached != null) return cached;
    const pending = withPatchPermit(async () => await options.getPatch(unit));
    patchByFileId.set(unit.fileId, pending);
    return pending;
  };
  const builtGroups = await Promise.all(groups.map(async (group, groupIndex) => {
    try {
      return await buildBatches(options, group, loadPatch);
    } catch (error) {
      return {
        batches: [],
        diagnostics: [`map.scout batch ${groupIndex + 1} input: ${sanitizeReviewMapDiagnostic(error)}`],
      };
    }
  }));
  const batches = builtGroups.flatMap((result) => result.batches);
  const buildDiagnostics = builtGroups.flatMap((result) => result.diagnostics);
  const batchResults = new Array<ReviewMapScoutResult>(batches.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < batches.length) {
      const batchIndex = nextIndex++;
      const batch = batches[batchIndex]!;
      const key = cacheKey(options, batch.units);
      const allowedUnitIds = new Set(batch.units.map((unit) => unit.id));
      const diagnostics: string[] = [];
      const cached = options.cache.get(key);
      let parsedFacts: ReviewMapScoutFact[] = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const raw = attempt === 1 && cached != null
            ? cached
            : await options.complete(attempt === 1 ? batch.initialInput : batch.retryInput);
          const parsed = parseFacts(raw, allowedUnitIds);
          options.cache.set(key, raw);
          parsedFacts = parsed.facts;
          diagnostics.push(...parsed.diagnostics);
          break;
        } catch (error) {
          diagnostics.push(`map.scout batch ${batchIndex + 1} attempt ${attempt}/2: ${sanitizeReviewMapDiagnostic(error)}`);
        }
      }
      batchResults[batchIndex] = { facts: parsedFacts, diagnostics };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, batches.length)) }, worker));
  return {
    facts: batchResults.flatMap((result) => result.facts),
    diagnostics: [...buildDiagnostics, ...batchResults.flatMap((result) => result.diagnostics)],
  };
}
