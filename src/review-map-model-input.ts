import type { ReviewChangeUnit } from "./types.js";

export const REVIEW_MAP_TEXT_LIMITS = {
  sourceLabel: 1_000,
  pullRequestTitle: 1_000,
  pullRequestBody: 8_000,
  commitSubject: 2_000,
  scoutText: 2_000,
  scoutArrayItems: 40,
  scoutFacts: 40,
  scoutRelationships: 40,
  diagnostic: 500,
} as const;

export interface ModelReviewUnit {
  id: string;
  fileId: string;
  path: string;
  symbol?: string;
  status: ReviewChangeUnit["status"];
  commitIds: string[];
  ranges: Array<{
    side: "original" | "modified";
    startLine: number;
    endLine: number;
  }>;
}

export interface FittedJson {
  input: string;
  variableChars: number;
}

export function projectReviewMapUnits(units: ReviewChangeUnit[]): ModelReviewUnit[] {
  return units.map((unit) => ({
    id: unit.id,
    fileId: unit.fileId,
    path: unit.path,
    ...(unit.symbol == null ? {} : { symbol: unit.symbol }),
    status: unit.status,
    commitIds: unit.commitIds,
    ranges: unit.ranges.map(({ side, startLine, endLine }) => ({ side, startLine, endLine })),
  }));
}

export function largestFittingJson(options: {
  maxInputChars: number;
  maxVariableChars: number;
  build: (variableChars: number) => unknown;
}): FittedJson | null {
  let low = 0;
  let high = Math.max(0, options.maxVariableChars);
  let best: FittedJson | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const input = JSON.stringify(options.build(middle));
    if (input.length <= options.maxInputChars) {
      best = { input, variableChars: middle };
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function truncateReviewMapText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

export function sanitizeReviewMapDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, REVIEW_MAP_TEXT_LIMITS.diagnostic);
}
