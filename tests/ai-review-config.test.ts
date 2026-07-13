import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadAiReviewRuntimeConfig } from "../src/ai-review-config.js";
import type { ReviewDataset } from "../src/sources/types.js";

function model(provider: string, id: string, reasoning = true): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "openai-responses",
    baseUrl: "https://example.test",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

function reasoningModel(provider: string, id: string): Model<Api> {
  return {
    ...model(provider, id),
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  };
}

function context(activeModel: Model<Api>, models: Model<Api>[]): ExtensionCommandContext {
  return {
    model: activeModel,
    modelRegistry: {
      getAll: () => models,
      find: (provider: string, modelId: string) => models.find((item) => item.provider === provider && item.id === modelId),
    },
  } as unknown as ExtensionCommandContext;
}

function dataset(repoRoot: string): ReviewDataset {
  return {
    repoRoot,
    workingRoot: repoRoot,
    files: [],
    analysisFileIds: [],
    commits: [],
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot,
      workingRoot: repoRoot,
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
  };
}

test("AI review config merges later partial phase config without resetting earlier defaults", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-config-"));
  const envPath = join(repoRoot, "override.json");
  const repoConfigDir = join(repoRoot, ".pi-diff-review-cockpit");
  await mkdir(repoConfigDir, { recursive: true });
  await writeFile(join(repoConfigDir, "config.json"), JSON.stringify({
    aiReview: {
      depth: "deep",
      parallelChapterReviews: 6,
      phases: {
        chapter: {
          provider: "anthropic",
          model: "reviewer",
          reasoning: "high",
        },
      },
    },
  }));
  await writeFile(envPath, JSON.stringify({
    aiReview: {
      phases: {
        chapter: {
          reasoning: "low",
        },
      },
    },
  }));

  const previousEnv = process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG;
  process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG = envPath;
  try {
    const active = reasoningModel("openai", "active");
    const reviewer = reasoningModel("anthropic", "reviewer");
    const config = await loadAiReviewRuntimeConfig(context(active, [active, reviewer]), dataset(repoRoot));

    assert.equal(config.public.depth, "deep");
    assert.equal(config.public.parallelChapterReviews, 6);
    assert.equal(config.public.phases.chapter.model, "anthropic/reviewer");
    assert.equal(config.public.phases.chapter.reasoning, "low");
    assert.equal(config.public.phases.validation.reasoning, "max");
  } finally {
    if (previousEnv == null) {
      delete process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG;
    } else {
      process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG = previousEnv;
    }
  }
});

test("AI review config resolves independent semantic map model routes", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-map-config-"));
  const repoConfigDir = join(repoRoot, ".pi-diff-review-cockpit");
  await mkdir(repoConfigDir, { recursive: true });
  await writeFile(join(repoConfigDir, "config.json"), JSON.stringify({
    aiReview: {
      map: {
        planner: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "max" },
      },
    },
  }));
  const models = [
    reasoningModel("openai-codex", "gpt-5.6-luna"),
    reasoningModel("openai-codex", "gpt-5.6-terra"),
    reasoningModel("openai-codex", "gpt-5.6-sol"),
  ];

  const config = await loadAiReviewRuntimeConfig(context(models[0]!, models), dataset(repoRoot));

  assert.deepEqual(config.public.mapPhases, {
    scout: { model: "openai-codex/gpt-5.6-luna", reasoning: "medium" },
    planner: { model: "openai-codex/gpt-5.6-sol", reasoning: "max" },
    critic: { model: "openai-codex/gpt-5.6-sol", reasoning: "xhigh" },
  });
});

test("AI review defaults route each depth through the appropriate GPT-5.6 categories", async () => {
  const models = [
    reasoningModel("openai-codex", "gpt-5.6-luna"),
    reasoningModel("openai-codex", "gpt-5.6-terra"),
    reasoningModel("openai-codex", "gpt-5.6-sol"),
  ];
  const expected = {
    fast: {
      scout: ["openai-codex/gpt-5.6-luna", "low"],
      chapter: ["openai-codex/gpt-5.6-luna", "medium"],
      validation: ["openai-codex/gpt-5.6-terra", "high"],
      synthesis: ["openai-codex/gpt-5.6-luna", "medium"],
    },
    standard: {
      scout: ["openai-codex/gpt-5.6-luna", "medium"],
      chapter: ["openai-codex/gpt-5.6-terra", "high"],
      validation: ["openai-codex/gpt-5.6-sol", "xhigh"],
      synthesis: ["openai-codex/gpt-5.6-terra", "high"],
    },
    deep: {
      scout: ["openai-codex/gpt-5.6-terra", "high"],
      chapter: ["openai-codex/gpt-5.6-sol", "xhigh"],
      validation: ["openai-codex/gpt-5.6-sol", "max"],
      synthesis: ["openai-codex/gpt-5.6-sol", "xhigh"],
    },
  } as const;

  for (const depth of ["fast", "standard", "deep"] as const) {
    const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-config-"));
    if (depth !== "standard") {
      await writeFile(join(repoRoot, "pi-diff-review-cockpit.config.json"), JSON.stringify({ aiReview: { depth } }));
    }
    const config = await loadAiReviewRuntimeConfig(context(models[0]!, models), dataset(repoRoot));
    for (const phase of ["scout", "chapter", "validation", "synthesis"] as const) {
      assert.deepEqual(
        [config.public.phases[phase].model, config.public.phases[phase].reasoning],
        expected[depth][phase],
      );
    }
  }
});

test("AI review phase overrides beat built-in routing and accept max reasoning", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-config-"));
  await writeFile(join(repoRoot, "pi-diff-review-cockpit.config.json"), JSON.stringify({
    aiReview: { phases: { chapter: { model: "team-reviewer", reasoning: "max" } } },
  }));
  const active = reasoningModel("openai-codex", "gpt-5.6-luna");
  const custom = reasoningModel("anthropic", "team-reviewer");
  const config = await loadAiReviewRuntimeConfig(context(active, [active, custom]), dataset(repoRoot));

  assert.equal(config.public.phases.chapter.model, "anthropic/team-reviewer");
  assert.equal(config.public.phases.chapter.reasoning, "max");
});

test("AI review built-in routes fall back to the active Pi model with warnings", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-config-"));
  const active = reasoningModel("openai-codex", "gpt-5.5");
  const config = await loadAiReviewRuntimeConfig(context(active, [active]), dataset(repoRoot));

  for (const phase of ["scout", "chapter", "validation", "synthesis"] as const) {
    assert.equal(config.public.phases[phase].model, "openai-codex/gpt-5.5");
  }
  assert.match(config.public.warnings.join("\n"), /gpt-5\.6-luna.*not found/i);
  assert.match(config.public.warnings.join("\n"), /gpt-5\.6-terra.*not found/i);
  assert.match(config.public.warnings.join("\n"), /gpt-5\.6-sol.*not found/i);
});

test("AI review config disables missing xhigh reasoning support with a warning", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-config-"));
  await writeFile(join(repoRoot, "pi-diff-review-cockpit.config.json"), JSON.stringify({
    aiReview: {
      phases: {
        validation: { reasoning: "xhigh" },
      },
    },
  }));

  const active = model("openai", "active");
  const config = await loadAiReviewRuntimeConfig(context(active, [active]), dataset(repoRoot));

  assert.equal(config.public.phases.validation.reasoning, "off");
  assert.match(config.public.warnings.join("\n"), /does not support that level/);
});

test("AI review config resolves custom composable review skills safely", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-config-"));
  const envPath = join(repoRoot, "override.json");
  await writeFile(envPath, JSON.stringify({
    aiReview: {
      skills: {
        enabled: ["security", "team-qa", "missing-skill"],
        disabled: ["security"],
        custom: [{
          id: "team-qa",
          title: "Team QA contracts",
          focus: "Headout QA workflow assumptions.",
          instructions: "Check QA label lifecycle and benchmark data compatibility before suggesting approval.",
        }],
        additionalInstructions: "Prefer fewer, higher-confidence comments.",
      },
    },
  }));

  const previousEnv = process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG;
  process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG = envPath;
  try {
    const active = model("openai", "active");
    const config = await loadAiReviewRuntimeConfig(context(active, [active]), dataset(repoRoot));

    assert.deepEqual(config.public.skills.enabled.map((skill) => skill.id), ["team-qa"]);
    assert.equal(config.public.skills.enabled[0]?.title, "Team QA contracts");
    assert.deepEqual(config.public.skills.disabled, ["security"]);
    assert.equal(config.public.skills.additionalInstructions, "Prefer fewer, higher-confidence comments.");
    assert.match(config.public.warnings.join("\n"), /missing-skill/);
  } finally {
    if (previousEnv == null) {
      delete process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG;
    } else {
      process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG = previousEnv;
    }
  }
});

test("AI review skill preset can reset an earlier explicit skill list", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-config-"));
  const envPath = join(repoRoot, "override.json");
  await writeFile(join(repoRoot, "pi-diff-review-cockpit.config.json"), JSON.stringify({
    aiReview: {
      skills: {
        enabled: ["security", "tests"],
      },
    },
  }));
  await writeFile(envPath, JSON.stringify({
    aiReview: {
      skills: {
        preset: "minimal",
      },
    },
  }));

  const previousEnv = process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG;
  process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG = envPath;
  try {
    const active = model("openai", "active");
    const config = await loadAiReviewRuntimeConfig(context(active, [active]), dataset(repoRoot));

    assert.equal(config.public.skills.preset, "minimal");
    assert.deepEqual(config.public.skills.enabled.map((skill) => skill.id), ["correctness"]);
  } finally {
    if (previousEnv == null) {
      delete process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG;
    } else {
      process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG = previousEnv;
    }
  }
});
