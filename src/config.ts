import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ReviewScope, ReviewWindowPreferences } from "./types.js";

export interface ReviewConfig extends ReviewWindowPreferences {
  autoFetchBaseRef: boolean;
}

export interface ReviewConfigLocations {
  globalConfigPath: string;
  projectConfigPath: string;
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  defaultBaseRef: "default",
  preferredInitialScope: "base-branch",
  preferredHideUnchanged: true,
  preferredWrapLines: false,
  preferredSidebarCollapsed: false,
  autoFetchBaseRef: true,
};

function isReviewScope(value: unknown): value is ReviewScope {
  return value === "base-branch" || value === "git-diff" || value === "last-commit" || value === "all-files";
}

function sanitizeConfig(value: unknown): Partial<ReviewConfig> {
  if (value == null || typeof value !== "object") return {};

  const input = value as Record<string, unknown>;
  const result: Partial<ReviewConfig> = {};

  if (typeof input.defaultBaseRef === "string" && input.defaultBaseRef.trim().length > 0) {
    result.defaultBaseRef = input.defaultBaseRef.trim();
  }
  if (isReviewScope(input.preferredInitialScope)) {
    result.preferredInitialScope = input.preferredInitialScope;
  }
  if (typeof input.preferredHideUnchanged === "boolean") {
    result.preferredHideUnchanged = input.preferredHideUnchanged;
  }
  if (typeof input.preferredWrapLines === "boolean") {
    result.preferredWrapLines = input.preferredWrapLines;
  }
  if (typeof input.preferredSidebarCollapsed === "boolean") {
    result.preferredSidebarCollapsed = input.preferredSidebarCollapsed;
  }
  if (typeof input.autoFetchBaseRef === "boolean") {
    result.autoFetchBaseRef = input.autoFetchBaseRef;
  }

  return result;
}

async function readJsonFile(path: string): Promise<Partial<ReviewConfig>> {
  try {
    const contents = await readFile(path, "utf8");
    return sanitizeConfig(JSON.parse(contents));
  } catch {
    return {};
  }
}

export function getReviewConfigLocations(repoRoot: string): ReviewConfigLocations {
  return {
    globalConfigPath: join(homedir(), ".pi", "agent", "pi-diff-review.json"),
    projectConfigPath: join(repoRoot, ".pi", "diff-review.json"),
  };
}

export async function loadReviewConfig(repoRoot: string): Promise<ReviewConfig> {
  const { globalConfigPath, projectConfigPath } = getReviewConfigLocations(repoRoot);
  const globalConfig = await readJsonFile(globalConfigPath);
  const projectConfig = await readJsonFile(projectConfigPath);

  return {
    ...DEFAULT_REVIEW_CONFIG,
    ...globalConfig,
    ...projectConfig,
  };
}

export async function saveReviewConfig(repoRoot: string, patch: Partial<ReviewConfig>, scope: "global" | "project"): Promise<string> {
  const { globalConfigPath, projectConfigPath } = getReviewConfigLocations(repoRoot);
  const path = scope === "global" ? globalConfigPath : projectConfigPath;
  const current = await readJsonFile(path);
  const next = {
    ...current,
    ...sanitizeConfig(patch),
  } satisfies Partial<ReviewConfig>;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return path;
}
