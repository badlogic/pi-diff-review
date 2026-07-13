import { compileReviewMap, ReviewMapQualityError } from "./review-map-compiler.js";
import { parseReviewMapPlan } from "./review-map-planner.js";
import type { ReviewMapScoutFact, ReviewMapScoutResult } from "./review-map-scout.js";
import type { ReviewChangeUnit, ReviewMap, ReviewMapProgress } from "./types.js";

export interface RunSemanticReviewMapOptions {
  sourceFingerprint: string;
  strategyVersion: string;
  units: ReviewChangeUnit[];
  provisionalMap: ReviewMap;
  runScouts: () => Promise<ReviewMapScoutResult>;
  plan: (facts: ReviewMapScoutFact[], repairInstructions?: string) => Promise<string>;
  criticize: (planJson: string, scoutDiagnostics: string[]) => Promise<string>;
  onProgress: (progress: ReviewMapProgress) => void;
}

function criticDecision(raw: string): { action: "accept" | "repair"; diagnostics: string[]; instructions?: string } {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Map critic response must be an object.");
  const value = parsed as Record<string, unknown>;
  if (value.action !== "accept" && value.action !== "repair") throw new Error("Map critic action must be accept or repair.");
  if (!Array.isArray(value.diagnostics) || !value.diagnostics.every((item) => typeof item === "string")) throw new Error("Map critic diagnostics must be strings.");
  if (value.action === "repair" && (typeof value.instructions !== "string" || value.instructions.trim().length === 0)) {
    throw new Error("Map critic repair requires instructions.");
  }
  return {
    action: value.action,
    diagnostics: value.diagnostics,
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
  };
}

function fallbackMap(provisionalMap: ReviewMap, diagnostics: string[]): ReviewMap {
  return {
    ...provisionalMap,
    status: "fallback",
    diagnostics: [...provisionalMap.diagnostics, ...diagnostics],
  };
}

export async function runSemanticReviewMap(options: RunSemanticReviewMapOptions): Promise<ReviewMap> {
  const diagnostics: string[] = [];
  try {
    options.onProgress({ phase: "scout", message: "Inspecting changed behavior and relationships." });
    const scoutResult = await options.runScouts();
    diagnostics.push(...scoutResult.diagnostics);

    options.onProgress({ phase: "planner", message: "Building the reviewer journey." });
    let rawPlan = await options.plan(scoutResult.facts);
    let plan = parseReviewMapPlan(rawPlan, options.units);

    options.onProgress({ phase: "critic", message: "Challenging map quality and review order." });
    const criticism = criticDecision(await options.criticize(rawPlan, scoutResult.diagnostics));
    diagnostics.push(...criticism.diagnostics);
    let repaired = false;
    if (criticism.action === "repair") {
      rawPlan = await options.plan(scoutResult.facts, criticism.instructions);
      plan = parseReviewMapPlan(rawPlan, options.units);
      repaired = true;
    }

    options.onProgress({ phase: "compile", message: "Proving exact changed-line coverage." });
    let map: ReviewMap;
    try {
      map = compileReviewMap({
        sourceFingerprint: options.sourceFingerprint,
        strategyVersion: options.strategyVersion,
        plan,
        units: options.units,
        status: repaired ? "semantic-repaired" : "semantic",
      });
    } catch (error) {
      if (repaired || !(error instanceof ReviewMapQualityError)) throw error;
      diagnostics.push(...error.diagnostics);
      rawPlan = await options.plan(scoutResult.facts, error.diagnostics.join("\n"));
      plan = parseReviewMapPlan(rawPlan, options.units);
      map = compileReviewMap({
        sourceFingerprint: options.sourceFingerprint,
        strategyVersion: options.strategyVersion,
        plan,
        units: options.units,
        status: "semantic-repaired",
      });
    }
    map.diagnostics.push(...diagnostics);
    options.onProgress({ phase: "done", message: "Semantic review plan is ready." });
    return map;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(message);
    options.onProgress({ phase: "failed", message: "Semantic mapping failed; using the deterministic review plan." });
    return fallbackMap(options.provisionalMap, diagnostics);
  }
}
