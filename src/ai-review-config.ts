import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewDataset } from "./sources/types.js";
import type {
  AiReviewDepth,
  AiReviewPhase,
  AiReviewResolvedConfig,
  AiReviewResolvedPhaseConfig,
  AiReviewResolvedSkillsConfig,
  AiReviewRuntimeConfig,
  ReviewMapModelPhase,
  AiReviewSkillDefinition,
  AiReviewSkillPreset,
} from "./types.js";

const CONFIG_ENV_VAR = "PI_DIFF_REVIEW_COCKPIT_CONFIG";

const PHASES: AiReviewPhase[] = ["scout", "chapter", "validation", "synthesis"];
const MAP_PHASES: ReviewMapModelPhase[] = ["scout", "planner", "critic"];

interface DefaultPhaseRoute {
  provider: string;
  model: string;
  reasoning: ThinkingLevel;
}

const DEFAULT_ROUTE_BY_DEPTH: Record<AiReviewDepth, Record<AiReviewPhase, DefaultPhaseRoute>> = {
  fast: {
    scout: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "low" },
    chapter: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "medium" },
    validation: { provider: "openai-codex", model: "gpt-5.6-terra", reasoning: "high" },
    synthesis: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "medium" },
  },
  standard: {
    scout: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "medium" },
    chapter: { provider: "openai-codex", model: "gpt-5.6-terra", reasoning: "high" },
    validation: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "xhigh" },
    synthesis: { provider: "openai-codex", model: "gpt-5.6-terra", reasoning: "high" },
  },
  deep: {
    scout: { provider: "openai-codex", model: "gpt-5.6-terra", reasoning: "high" },
    chapter: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "xhigh" },
    validation: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "max" },
    synthesis: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "xhigh" },
  },
};

const DEFAULT_MAP_ROUTE_BY_DEPTH: Record<AiReviewDepth, Record<ReviewMapModelPhase, DefaultPhaseRoute>> = {
  fast: {
    scout: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "low" },
    planner: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "medium" },
    critic: { provider: "openai-codex", model: "gpt-5.6-terra", reasoning: "high" },
  },
  standard: {
    scout: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "medium" },
    planner: { provider: "openai-codex", model: "gpt-5.6-terra", reasoning: "high" },
    critic: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "xhigh" },
  },
  deep: {
    scout: { provider: "openai-codex", model: "gpt-5.6-terra", reasoning: "high" },
    planner: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "xhigh" },
    critic: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "max" },
  },
};

const DEPTH_LIMITS: Record<AiReviewDepth, {
  parallelChapterReviews: number;
  maxPatchCharsPerFile: number;
  maxChapterPatchChars: number;
  maxFindingsPerChapter: number;
}> = {
  fast: {
    parallelChapterReviews: 4,
    maxPatchCharsPerFile: 12_000,
    maxChapterPatchChars: 45_000,
    maxFindingsPerChapter: 4,
  },
  standard: {
    parallelChapterReviews: 3,
    maxPatchCharsPerFile: 24_000,
    maxChapterPatchChars: 90_000,
    maxFindingsPerChapter: 8,
  },
  deep: {
    parallelChapterReviews: 2,
    maxPatchCharsPerFile: 48_000,
    maxChapterPatchChars: 180_000,
    maxFindingsPerChapter: 12,
  },
};

const DEFAULT_SKILL_PRESET: AiReviewSkillPreset = "balanced";

const BUILT_IN_REVIEW_SKILLS: AiReviewSkillDefinition[] = [
  {
    id: "correctness",
    title: "Correctness",
    focus: "Concrete behavior regressions, bad state transitions, broken edge cases, and logic that no longer matches the changed contract.",
    instructions: "Look for issues that can be explained from the diff and nearby context. Prefer one strong, changed-line-backed finding over multiple speculative comments. Ignore style-only concerns.",
  },
  {
    id: "contracts",
    title: "Contracts and data shape",
    focus: "API contracts, type/schema changes, migrations, persistence models, serialization, backwards compatibility, and caller/callee expectations.",
    instructions: "Check whether new fields, enums, migrations, validation rules, and public interfaces stay compatible with existing callers and stored data. Flag ordering, rollback, or mismatch risks only when supported by changed lines.",
  },
  {
    id: "tests",
    title: "Tests and coverage",
    focus: "Missing or weak tests for changed behavior, boundary cases, migrations, auth gates, error paths, and contract changes.",
    instructions: "Create test-gap findings only when the diff introduces meaningful behavior without corresponding coverage or when existing tests appear to assert the wrong contract.",
  },
  {
    id: "silent-failures",
    title: "Silent failures",
    focus: "Swallowed errors, lossy fallbacks, partial writes, retries, timeouts, null handling, and logging that can hide production failures.",
    instructions: "Prioritize paths where a user-visible or data-integrity failure could be hidden, retried unsafely, or reported as success.",
  },
  {
    id: "security",
    title: "Security and isolation",
    focus: "Authz/authn gaps, tenant or source isolation, path traversal, injection, secrets, unsafe deserialization, and dangerous external calls.",
    instructions: "Flag only concrete security or isolation risks tied to changed code. Do not stretch generic best practices into security findings.",
  },
  {
    id: "comments",
    title: "Comments and docs",
    focus: "Changed comments, docstrings, README text, generated docs, and inline guidance that conflicts with executable behavior.",
    instructions: "Use this skill sparingly. Report stale or misleading prose only when it can mislead a reviewer, operator, or future maintainer about changed behavior.",
  },
  {
    id: "adversarial",
    title: "Adversarial review",
    focus: "High-impact failure modes, surprising interactions across chapters, rollback safety, concurrency, idempotency, and data corruption risks.",
    instructions: "Act like a validation critic. Try to falsify the patch, but only promote issues that remain concrete after checking changed lines and adjacent context.",
  },
];

const SKILL_PRESETS: Record<AiReviewSkillPreset, string[]> = {
  minimal: ["correctness"],
  balanced: ["correctness", "contracts", "tests", "silent-failures", "security", "comments"],
  security: ["security", "silent-failures", "contracts", "tests"],
  exhaustive: ["correctness", "contracts", "tests", "silent-failures", "security", "comments", "adversarial"],
};

type RawConfig = {
  aiReview?: RawAiReviewConfig;
} | RawAiReviewConfig;

interface RawAiReviewConfig {
  depth?: unknown;
  parallelChapterReviews?: unknown;
  maxPatchCharsPerFile?: unknown;
  maxChapterPatchChars?: unknown;
  maxFindingsPerChapter?: unknown;
  phases?: Partial<Record<AiReviewPhase, RawPhaseConfig>>;
  map?: Partial<Record<ReviewMapModelPhase, RawPhaseConfig>>;
  skills?: unknown;
  reviewSkills?: unknown;
}

interface RawPhaseConfig {
  provider?: unknown;
  model?: unknown;
  reasoning?: unknown;
}

interface NormalizedPhaseConfig {
  provider?: string;
  model?: string;
  reasoning?: "off" | ThinkingLevel;
}

interface NormalizedConfig {
  depth?: AiReviewDepth;
  parallelChapterReviews?: number;
  maxPatchCharsPerFile?: number;
  maxChapterPatchChars?: number;
  maxFindingsPerChapter?: number;
  phases: Partial<Record<AiReviewPhase, NormalizedPhaseConfig>>;
  mapPhases: Partial<Record<ReviewMapModelPhase, NormalizedPhaseConfig>>;
  skills?: NormalizedSkillsConfig;
}

interface NormalizedSkillsConfig {
  preset?: AiReviewSkillPreset;
  enabled?: string[];
  disabled?: string[];
  custom?: AiReviewSkillDefinition[];
  additionalInstructions?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isDepth(value: unknown): value is AiReviewDepth {
  return value === "fast" || value === "standard" || value === "deep";
}

function isSkillPreset(value: unknown): value is AiReviewSkillPreset {
  return value === "minimal" || value === "balanced" || value === "security" || value === "exhaustive";
}

function isReasoning(value: unknown): value is "off" | ThinkingLevel {
  return value === "off"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max";
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function configBody(raw: RawConfig): RawAiReviewConfig {
  if (isRecord(raw) && isRecord(raw.aiReview)) {
    return raw.aiReview as RawAiReviewConfig;
  }
  return raw as RawAiReviewConfig;
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength).trim() : trimmed;
}

function cleanSkillId(value: unknown): string | undefined {
  const trimmed = cleanString(value, 80);
  if (!trimmed) return undefined;
  return /^[a-z0-9][a-z0-9._-]*$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(cleanSkillId).filter((item): item is string => item != null);
  return values.length > 0 ? [...new Set(values)] : [];
}

function normalizeCustomSkills(value: unknown): AiReviewSkillDefinition[] {
  const rawItems = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.entries(value).map(([id, instructions]) => ({ id, instructions }))
      : [];
  const skills: AiReviewSkillDefinition[] = [];
  const seen = new Set<string>();

  for (const item of rawItems.slice(0, 12)) {
    if (!isRecord(item)) continue;
    const id = cleanSkillId(item.id);
    const instructions = cleanString(item.instructions, 4_000);
    if (!id || !instructions || seen.has(id)) continue;
    seen.add(id);
    skills.push({
      id,
      title: cleanString(item.title, 120) ?? id,
      focus: cleanString(item.focus, 500) ?? "Custom review focus.",
      instructions,
    });
  }

  return skills;
}

function normalizeSkillsConfig(value: unknown): NormalizedSkillsConfig | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    return { enabled: stringArray(value) ?? [] };
  }
  if (!isRecord(value)) return undefined;
  const enabled = stringArray(value.enabled);
  const disabled = stringArray(value.disabled);
  const custom = normalizeCustomSkills(value.custom);
  const additionalInstructions = cleanString(value.additionalInstructions, 4_000);

  return {
    ...(isSkillPreset(value.preset) ? { preset: value.preset } : {}),
    ...(enabled ? { enabled } : {}),
    ...(disabled ? { disabled } : {}),
    ...(custom.length > 0 ? { custom } : {}),
    ...(additionalInstructions ? { additionalInstructions } : {}),
  };
}

function normalizeConfig(raw: RawConfig): NormalizedConfig {
  const body = configBody(raw);
  const phases: Partial<Record<AiReviewPhase, NormalizedPhaseConfig>> = {};
  const rawPhases = isRecord(body.phases) ? body.phases : {};
  const rawMapPhases = isRecord(body.map) ? body.map : {};
  const mapPhases: Partial<Record<ReviewMapModelPhase, NormalizedPhaseConfig>> = {};
  const skills = normalizeSkillsConfig(body.skills ?? body.reviewSkills);

  for (const phase of PHASES) {
    const rawPhase = rawPhases[phase];
    if (!isRecord(rawPhase)) continue;
    phases[phase] = {
      ...(typeof rawPhase.provider === "string" && rawPhase.provider.trim().length > 0 ? { provider: rawPhase.provider.trim() } : {}),
      ...(typeof rawPhase.model === "string" && rawPhase.model.trim().length > 0 ? { model: rawPhase.model.trim() } : {}),
      ...(isReasoning(rawPhase.reasoning) ? { reasoning: rawPhase.reasoning } : {}),
    };
  }
  for (const phase of MAP_PHASES) {
    const rawPhase = rawMapPhases[phase];
    if (!isRecord(rawPhase)) continue;
    mapPhases[phase] = {
      ...(typeof rawPhase.provider === "string" && rawPhase.provider.trim().length > 0 ? { provider: rawPhase.provider.trim() } : {}),
      ...(typeof rawPhase.model === "string" && rawPhase.model.trim().length > 0 ? { model: rawPhase.model.trim() } : {}),
      ...(isReasoning(rawPhase.reasoning) ? { reasoning: rawPhase.reasoning } : {}),
    };
  }

  return {
    ...(isDepth(body.depth) ? { depth: body.depth } : {}),
    parallelChapterReviews: positiveInteger(body.parallelChapterReviews),
    maxPatchCharsPerFile: positiveInteger(body.maxPatchCharsPerFile),
    maxChapterPatchChars: positiveInteger(body.maxChapterPatchChars),
    maxFindingsPerChapter: positiveInteger(body.maxFindingsPerChapter),
    phases,
    mapPhases,
    ...(skills ? { skills } : {}),
  };
}

function mergeSkillsConfig(left: NormalizedSkillsConfig | undefined, right: NormalizedSkillsConfig | undefined): NormalizedSkillsConfig | undefined {
  if (!left) return right;
  if (!right) return left;
  const resetToPreset = right.preset != null && right.enabled == null;
  const enabled = right.enabled ?? (resetToPreset ? undefined : left.enabled);
  const disabled = right.disabled ?? (resetToPreset ? undefined : left.disabled);
  const custom = [
    ...(left.custom ?? []),
    ...(right.custom ?? []),
  ];
  return {
    ...(right.preset ?? left.preset ? { preset: right.preset ?? left.preset } : {}),
    ...(enabled ? { enabled } : {}),
    ...(disabled ? { disabled } : {}),
    ...(custom.length > 0 ? { custom } : {}),
    ...(right.additionalInstructions ?? left.additionalInstructions ? { additionalInstructions: right.additionalInstructions ?? left.additionalInstructions } : {}),
  };
}

function mergeConfig(left: NormalizedConfig, right: NormalizedConfig): NormalizedConfig {
  const mergedPhases = Object.fromEntries(PHASES.map((phase) => [
    phase,
    {
      ...(left.phases[phase] ?? {}),
      ...(right.phases[phase] ?? {}),
    },
  ])) as Partial<Record<AiReviewPhase, NormalizedPhaseConfig>>;

  const skills = mergeSkillsConfig(left.skills, right.skills);
  const mergedMapPhases = Object.fromEntries(MAP_PHASES.map((phase) => [
    phase,
    {
      ...(left.mapPhases[phase] ?? {}),
      ...(right.mapPhases[phase] ?? {}),
    },
  ])) as Partial<Record<ReviewMapModelPhase, NormalizedPhaseConfig>>;
  return {
    ...(left.depth ? { depth: left.depth } : {}),
    ...(right.depth ? { depth: right.depth } : {}),
    parallelChapterReviews: right.parallelChapterReviews ?? left.parallelChapterReviews,
    maxPatchCharsPerFile: right.maxPatchCharsPerFile ?? left.maxPatchCharsPerFile,
    maxChapterPatchChars: right.maxChapterPatchChars ?? left.maxChapterPatchChars,
    maxFindingsPerChapter: right.maxFindingsPerChapter ?? left.maxFindingsPerChapter,
    phases: mergedPhases,
    mapPhases: mergedMapPhases,
    ...(skills ? { skills } : {}),
  };
}

function resolveSkillsConfig(config: NormalizedSkillsConfig | undefined, warnings: string[]): AiReviewResolvedSkillsConfig {
  const preset = config?.preset ?? DEFAULT_SKILL_PRESET;
  const builtIns = new Map(BUILT_IN_REVIEW_SKILLS.map((skill) => [skill.id, skill] as const));
  const custom = new Map((config?.custom ?? []).map((skill) => [skill.id, skill] as const));
  const registry = new Map<string, AiReviewSkillDefinition>([...builtIns, ...custom]);
  const disabled = new Set(config?.disabled ?? []);
  const requested = config?.enabled ?? SKILL_PRESETS[preset];
  const enabled: AiReviewSkillDefinition[] = [];

  for (const id of requested) {
    if (disabled.has(id)) continue;
    const skill = registry.get(id);
    if (!skill) {
      warnings.push(`AI review skill "${id}" was not found and will be ignored.`);
      continue;
    }
    if (enabled.some((item) => item.id === skill.id)) continue;
    enabled.push(skill);
  }

  if (enabled.length === 0) {
    warnings.push("AI review skills resolved to an empty set; using the correctness skill.");
    enabled.push(BUILT_IN_REVIEW_SKILLS[0]!);
  }

  return {
    preset,
    enabled,
    disabled: [...disabled],
    additionalInstructions: config?.additionalInstructions ?? null,
  };
}

async function readConfigFile(path: string): Promise<RawConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RawConfig;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${error.message}`);
    }
    return null;
  }
}

function candidateConfigPaths(dataset: ReviewDataset): string[] {
  const paths = [
    join(homedir(), ".config", "pi-diff-review-cockpit", "config.json"),
    join(dataset.repoRoot, ".pi-diff-review-cockpit", "config.json"),
    join(dataset.repoRoot, "pi-diff-review-cockpit.config.json"),
  ];
  const envPath = process.env[CONFIG_ENV_VAR];
  if (envPath && envPath.trim().length > 0) {
    paths.push(resolve(envPath.trim()));
  }
  return [...new Set(paths.map((path) => resolve(path)))];
}

async function loadConfig(dataset: ReviewDataset): Promise<{ config: NormalizedConfig; paths: string[]; warnings: string[] }> {
  let config = normalizeConfig({});
  const paths: string[] = [];
  const warnings: string[] = [];

  for (const path of candidateConfigPaths(dataset)) {
    try {
      const raw = await readConfigFile(path);
      if (raw == null) continue;
      config = mergeConfig(config, normalizeConfig(raw));
      paths.push(path);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { config, paths, warnings };
}

function describeModel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function supportsReasoningLevel(model: Model<Api>, reasoning: ThinkingLevel): boolean {
  return getSupportedThinkingLevels(model).includes(reasoning);
}

function resolveModel(ctx: ExtensionCommandContext, phase: string, config: NormalizedPhaseConfig | undefined, warnings: string[]): Model<Api> | null {
  const fallbackModel = ctx.model ?? null;
  if (!config?.model) return fallbackModel;

  if (config.provider) {
    const model = ctx.modelRegistry.find(config.provider, config.model);
    if (model) return model;
    warnings.push(`AI review ${phase} model ${config.provider}/${config.model} was not found; using active PI model instead.`);
    return fallbackModel;
  }

  const matches = ctx.modelRegistry.getAll().filter((model) => model.id === config.model);
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    warnings.push(`AI review ${phase} model "${config.model}" is ambiguous; set provider as well. Using active PI model instead.`);
  } else {
    warnings.push(`AI review ${phase} model "${config.model}" was not found; using active PI model instead.`);
  }
  return fallbackModel;
}

function resolveMapPhaseConfig(
  ctx: ExtensionCommandContext,
  phase: ReviewMapModelPhase,
  config: NormalizedConfig & { depth: AiReviewDepth },
  warnings: string[],
): { runtime: AiReviewRuntimeConfig["mapPhases"][ReviewMapModelPhase]; resolved: AiReviewResolvedPhaseConfig } {
  const phaseConfig = config.mapPhases[phase];
  const defaultRoute = DEFAULT_MAP_ROUTE_BY_DEPTH[config.depth][phase];
  const modelConfig = phaseConfig?.model ? phaseConfig : defaultRoute;
  const model = resolveModel(ctx, `map.${phase}`, modelConfig, warnings);
  const configuredReasoning = phaseConfig?.reasoning ?? defaultRoute.reasoning;
  const reasoning = configuredReasoning === "off" || !model?.reasoning || !supportsReasoningLevel(model, configuredReasoning)
    ? undefined
    : configuredReasoning;
  if (configuredReasoning !== "off" && model && (!model.reasoning || !supportsReasoningLevel(model, configuredReasoning))) {
    warnings.push(`AI review map.${phase} requested ${configuredReasoning} reasoning, but ${describeModel(model)} does not support that level.`);
  }
  return {
    runtime: { model, reasoning, modelLabel: model ? describeModel(model) : "No active PI model" },
    resolved: { model: model ? describeModel(model) : null, reasoning: reasoning ?? "off" },
  };
}

function resolvePhaseConfig(
  ctx: ExtensionCommandContext,
  phase: AiReviewPhase,
  config: NormalizedConfig & { depth: AiReviewDepth },
  warnings: string[],
): { runtime: AiReviewRuntimeConfig["phases"][AiReviewPhase]; resolved: AiReviewResolvedPhaseConfig } {
  const phaseConfig = config.phases[phase];
  const defaultRoute = DEFAULT_ROUTE_BY_DEPTH[config.depth][phase];
  const modelConfig = phaseConfig?.model ? phaseConfig : defaultRoute;
  const model = resolveModel(ctx, phase, modelConfig, warnings);
  const configuredReasoning = phaseConfig?.reasoning ?? defaultRoute.reasoning;
  const reasoning = configuredReasoning === "off" || !model?.reasoning || (model != null && !supportsReasoningLevel(model, configuredReasoning)) ? undefined : configuredReasoning;
  if (configuredReasoning !== "off" && model && !model.reasoning) {
    warnings.push(`AI review ${phase} requested ${configuredReasoning} reasoning, but ${describeModel(model)} does not support reasoning.`);
  }
  if (configuredReasoning !== "off" && model?.reasoning && !supportsReasoningLevel(model, configuredReasoning)) {
    warnings.push(`AI review ${phase} requested ${configuredReasoning} reasoning, but ${describeModel(model)} does not support that level.`);
  }

  return {
    runtime: {
      model,
      reasoning,
      modelLabel: model ? describeModel(model) : "No active PI model",
    },
    resolved: {
      model: model ? describeModel(model) : null,
      reasoning: reasoning ?? "off",
    },
  };
}

export async function loadAiReviewRuntimeConfig(ctx: ExtensionCommandContext, dataset: ReviewDataset): Promise<AiReviewRuntimeConfig> {
  const loaded = await loadConfig(dataset);
  const depth = loaded.config.depth ?? "standard";
  const config = {
    ...loaded.config,
    depth,
  };
  const limits = DEPTH_LIMITS[depth];
  const warnings = [...loaded.warnings];
  const resolvedPhases = PHASES.map((phase) => {
    const resolved = resolvePhaseConfig(ctx, phase, config, warnings);
    return { phase, ...resolved };
  });
  const phases = Object.fromEntries(resolvedPhases.map(({ phase, runtime }) => [phase, runtime])) as AiReviewRuntimeConfig["phases"];
  const publicPhases = Object.fromEntries(resolvedPhases.map(({ phase, resolved }) => [phase, resolved])) as AiReviewResolvedConfig["phases"];
  const resolvedMapPhases = MAP_PHASES.map((phase) => ({ phase, ...resolveMapPhaseConfig(ctx, phase, config, warnings) }));
  const mapPhases = Object.fromEntries(resolvedMapPhases.map(({ phase, runtime }) => [phase, runtime])) as AiReviewRuntimeConfig["mapPhases"];
  const publicMapPhases = Object.fromEntries(resolvedMapPhases.map(({ phase, resolved }) => [phase, resolved])) as AiReviewResolvedConfig["mapPhases"];
  const skills = resolveSkillsConfig(config.skills, warnings);

  const parallelChapterReviews = clamp(config.parallelChapterReviews ?? limits.parallelChapterReviews, 1, 12);
  const maxPatchCharsPerFile = clamp(config.maxPatchCharsPerFile ?? limits.maxPatchCharsPerFile, 1_000, 200_000);
  const maxChapterPatchChars = clamp(config.maxChapterPatchChars ?? limits.maxChapterPatchChars, 5_000, 500_000);
  const maxFindingsPerChapter = clamp(config.maxFindingsPerChapter ?? limits.maxFindingsPerChapter, 1, 50);

  return {
    depth,
    parallelChapterReviews,
    maxPatchCharsPerFile,
    maxChapterPatchChars,
    maxFindingsPerChapter,
    phases,
    mapPhases,
    skills,
    public: {
      depth,
      parallelChapterReviews,
      maxPatchCharsPerFile,
      maxChapterPatchChars,
      maxFindingsPerChapter,
      configPaths: loaded.paths,
      warnings: [...new Set(warnings)],
      phases: publicPhases,
      mapPhases: publicMapPhases,
      skills,
    },
  };
}
