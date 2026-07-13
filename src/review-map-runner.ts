import { compileReviewMap, ReviewMapRepairableQualityError } from "./review-map-compiler.js";
import { parseReviewMapPlan } from "./review-map-planner.js";
import type { ReviewMapPlan } from "./review-map-planner.js";
import { sanitizeReviewMapDiagnostic } from "./review-map-model-input.js";
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
    diagnostics: value.diagnostics.slice(0, 40).map((diagnostic) => sanitizeReviewMapDiagnostic(diagnostic)),
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
  };
}

const MAX_PLANNER_CALLS = 3;

interface ValidPlanCandidate {
  raw: string;
  plan: ReviewMapPlan;
}

export function createFallbackReviewMap(provisionalMap: ReviewMap, diagnostics: string[]): ReviewMap {
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
    let plannerCalls = 0;
    const requestValidPlan = async (
      repairInstructions?: string,
      repairStage = "map.planner contract",
    ): Promise<ValidPlanCandidate> => {
      let instructions = repairInstructions;
      let stage = repairStage;
      while (plannerCalls < MAX_PLANNER_CALLS) {
        if (plannerCalls > 0) diagnostics.push(`${stage} repair ${plannerCalls}/2`);
        const raw = await options.plan(scoutResult.facts, instructions);
        plannerCalls += 1;
        try {
          return { raw, plan: parseReviewMapPlan(raw, options.units) };
        } catch (error) {
          const reason = sanitizeReviewMapDiagnostic(error);
          if (plannerCalls >= MAX_PLANNER_CALLS) {
            throw new Error(`Planner repair budget exhausted: ${reason}`);
          }
          stage = "map.planner contract";
          instructions = `Return a plan that satisfies the exact schema and enum contract. Validation error: ${reason}`;
        }
      }
      throw new Error("Planner repair budget exhausted.");
    };
    let candidate = await requestValidPlan();

    options.onProgress({ phase: "critic", message: "Challenging map quality and review order." });
    let criticism: ReturnType<typeof criticDecision> | null = null;
    try {
      criticism = criticDecision(await options.criticize(candidate.raw, scoutResult.diagnostics));
      diagnostics.push(...criticism.diagnostics);
    } catch (error) {
      diagnostics.push(`map.critic: ${sanitizeReviewMapDiagnostic(error)}`);
    }
    if (criticism?.action === "repair") {
      candidate = await requestValidPlan(criticism.instructions, "map.critic");
    }

    options.onProgress({ phase: "compile", message: "Proving exact changed-line coverage." });
    let map: ReviewMap | null = null;
    while (map == null) {
      try {
        map = compileReviewMap({
          sourceFingerprint: options.sourceFingerprint,
          strategyVersion: options.strategyVersion,
          plan: candidate.plan,
          units: options.units,
          status: plannerCalls > 1 ? "semantic-repaired" : "semantic",
        });
      } catch (error) {
        if (!(error instanceof ReviewMapRepairableQualityError)) throw error;
        diagnostics.push(...error.diagnostics.map((diagnostic) => sanitizeReviewMapDiagnostic(diagnostic)));
        candidate = await requestValidPlan(error.diagnostics.join("\n"), "map.compiler quality");
      }
    }
    map.diagnostics.push(...diagnostics);
    options.onProgress({ phase: "done", message: "Semantic review plan is ready." });
    return map;
  } catch (error) {
    const message = sanitizeReviewMapDiagnostic(error);
    diagnostics.push(message);
    options.onProgress({ phase: "failed", message: "Semantic mapping failed; using the deterministic review plan." });
    return createFallbackReviewMap(options.provisionalMap, diagnostics);
  }
}
