import { createHash } from "node:crypto";
import { parseCanonicalPatchHunks } from "./git.js";
import type { ReviewChangeUnit, ReviewChapterRange, ReviewFile } from "./types.js";

export interface ExtractReviewChangeUnitsOptions {
  sourceFingerprint: string;
  file: ReviewFile;
  patch: string;
  commitIds: string[];
}

function stableUnitId(input: object): string {
  return `unit-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 20)}`;
}

function toRanges(file: ReviewFile, side: "original" | "modified", ranges: Array<{ start: number; end: number }>): ReviewChapterRange[] {
  return ranges.map((range) => ({
    fileId: file.id,
    path: file.path,
    side,
    startLine: range.start,
    endLine: range.end,
  }));
}

function fallbackRanges(file: ReviewFile): ReviewChapterRange[] {
  const comparison = file.gitDiff ?? file.lastCommit ?? Object.values(file.commitComparisons)[0] ?? null;
  if (comparison == null) return [];
  return [
    ...toRanges(file, "original", comparison.commentableOriginalLines ?? []),
    ...toRanges(file, "modified", comparison.commentableModifiedLines ?? []),
  ];
}

export function extractReviewChangeUnits(options: ExtractReviewChangeUnitsOptions): ReviewChangeUnit[] {
  const comparison = options.file.gitDiff ?? options.file.lastCommit ?? Object.values(options.file.commitComparisons)[0] ?? null;
  if (comparison == null) return [];
  const hunks = parseCanonicalPatchHunks(options.patch);
  const candidates = hunks.length > 0
    ? hunks.map((hunk) => ({
        symbol: hunk.symbol,
        patch: hunk.patch,
        ranges: [
          ...toRanges(options.file, "original", hunk.originalRanges),
          ...toRanges(options.file, "modified", hunk.modifiedRanges),
        ],
      })).filter((candidate) => candidate.ranges.length > 0)
    : [{ symbol: null, patch: options.patch, ranges: fallbackRanges(options.file) }];

  return candidates.map((candidate) => {
    const identity = {
      sourceFingerprint: options.sourceFingerprint,
      fileId: options.file.id,
      path: options.file.path,
      status: comparison.status,
      ranges: candidate.ranges,
      patchHash: createHash("sha256").update(candidate.patch).digest("hex"),
    };
    return {
      id: stableUnitId(identity),
      fileId: options.file.id,
      path: options.file.path,
      ...(candidate.symbol == null ? {} : { symbol: candidate.symbol }),
      ranges: candidate.ranges,
      status: comparison.status,
      commitIds: [...new Set(options.commitIds)],
    };
  });
}

function lineKeys(unit: ReviewChangeUnit): Set<string> {
  const keys = new Set<string>();
  for (const range of unit.ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      keys.add(`${range.side}:${line}`);
    }
  }
  return keys;
}

export function validateChangeUnitSubdivision(parent: ReviewChangeUnit, children: ReviewChangeUnit[]): boolean {
  if (children.length === 0) return false;
  const expected = lineKeys(parent);
  const actual = new Set<string>();
  for (const child of children) {
    if (child.fileId !== parent.fileId || child.path !== parent.path || child.status !== parent.status) return false;
    for (const key of lineKeys(child)) {
      if (!expected.has(key) || actual.has(key)) return false;
      actual.add(key);
    }
  }
  return actual.size === expected.size;
}
