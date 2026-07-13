import { createHash } from "node:crypto";
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

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value.slice(0, 40) : null;
}

function parseFacts(raw: string, allowedUnitIds: ReadonlySet<string>): ReviewMapScoutFact[] {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Scout response must be an object.");
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) throw new Error("Scout response must contain facts.");
  return facts.map((item) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) throw new Error("Scout fact must be an object.");
    const fact = item as Record<string, unknown>;
    const unitIds = stringArray(fact.unitIds);
    const changedContracts = stringArray(fact.changedContracts);
    const callersAndDependencies = stringArray(fact.callersAndDependencies);
    const removedBehavior = stringArray(fact.removedBehavior);
    const invariants = stringArray(fact.invariants);
    const testEvidence = stringArray(fact.testEvidence);
    const evidenceGaps = stringArray(fact.evidenceGaps);
    const unresolvedQuestions = stringArray(fact.unresolvedQuestions);
    if (unitIds == null || unitIds.length === 0 || unitIds.some((id) => !allowedUnitIds.has(id))) {
      throw new Error("Scout fact references an unknown or invented change unit.");
    }
    if (typeof fact.intent !== "string"
      || changedContracts == null
      || callersAndDependencies == null
      || removedBehavior == null
      || invariants == null
      || testEvidence == null
      || evidenceGaps == null
      || unresolvedQuestions == null
      || !Array.isArray(fact.candidateRelationships)
      || !["critical", "high", "medium", "low", "info"].includes(String(fact.confidence))) {
      throw new Error("Scout fact has an invalid shape.");
    }
    const candidateRelationships = fact.candidateRelationships.map((relationship) => {
      if (relationship == null || typeof relationship !== "object" || Array.isArray(relationship)) throw new Error("Scout relationship must be an object.");
      const value = relationship as Record<string, unknown>;
      if (typeof value.fromUnitId !== "string" || typeof value.toUnitId !== "string" || typeof value.reason !== "string"
        || !allowedUnitIds.has(value.fromUnitId) || !allowedUnitIds.has(value.toUnitId)) {
        throw new Error("Scout relationship references an unknown or invented change unit.");
      }
      return { fromUnitId: value.fromUnitId, toUnitId: value.toUnitId, reason: value.reason };
    });
    return {
      unitIds,
      intent: fact.intent,
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
}

async function buildInput(options: RunReviewMapScoutsOptions, units: ReviewChangeUnit[]): Promise<string> {
  const base = {
    sourceFingerprint: options.sourceFingerprint,
    units: await Promise.all(units.map(async (unit) => ({
      id: unit.id,
      path: unit.path,
      symbol: unit.symbol ?? null,
      status: unit.status,
      ranges: unit.ranges,
      commitIds: unit.commitIds,
      patch: await options.getPatch(unit),
    }))),
  };
  let input = JSON.stringify(base);
  if (input.length <= options.maxInputChars) return input;
  const fixedSize = JSON.stringify({ ...base, units: base.units.map((unit) => ({ ...unit, patch: "" })) }).length;
  const patchBudget = Math.max(0, options.maxInputChars - fixedSize - base.units.length * 8);
  const perUnit = Math.floor(patchBudget / Math.max(1, base.units.length));
  input = JSON.stringify({ ...base, units: base.units.map((unit) => ({ ...unit, patch: unit.patch.slice(0, perUnit) })) });
  if (input.length > options.maxInputChars) throw new Error("Scout metadata exceeds the configured input budget.");
  return input;
}

export async function runReviewMapScouts(options: RunReviewMapScoutsOptions): Promise<ReviewMapScoutResult> {
  const groups = groupsFor(options.units);
  const facts: ReviewMapScoutFact[] = [];
  const diagnostics: string[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < groups.length) {
      const group = groups[nextIndex++]!;
      const key = cacheKey(options, group);
      try {
        const raw = options.cache.get(key) ?? await options.complete(await buildInput(options, group));
        const parsed = parseFacts(raw, new Set(group.map((unit) => unit.id)));
        options.cache.set(key, raw);
        facts.push(...parsed);
      } catch (error) {
        diagnostics.push(error instanceof Error ? error.message : String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, groups.length)) }, worker));
  return { facts, diagnostics };
}
