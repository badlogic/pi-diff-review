# GPT-5.6 Review Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each AI review phase to the appropriate GPT-5.6 category model and reasoning level for the selected review depth while preserving overrides and safe fallback.

**Architecture:** Replace the reasoning-only depth defaults with a depth-aware phase route containing provider, model, and reasoning. Resolve an explicit phase model ahead of the built-in route; otherwise use the built-in GPT-5.6 model. Keep the existing active-model fallback and reasoning-capability checks unchanged at the trust boundary.

**Tech Stack:** TypeScript, Node.js test runner, Pi 0.80.6 model registry, JSON configuration, Markdown documentation.

---

## File Structure

- Modify `src/ai-review-config.ts`: define and resolve the built-in depth-aware model matrix and accept `max` reasoning in JSON.
- Modify `tests/ai-review-config.test.ts`: verify every depth route, user override precedence, `max`, and missing-model fallback.
- Modify `README.md`: document the product defaults and Pi catalog requirement.
- Modify `tests/smoke.test.ts`: keep the documented model contract from drifting.
- No new runtime module is needed; routing belongs in the existing configuration resolver.

### Task 1: Add Depth-Aware GPT-5.6 Routing

**Files:**
- Modify: `tests/ai-review-config.test.ts`
- Modify: `src/ai-review-config.ts`

- [ ] **Step 1: Add a reasoning-model fixture**

Add this helper below the existing `model()` helper in `tests/ai-review-config.test.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing default-matrix test**

Add a test that creates the three GPT-5.6 models and loads each review depth:

```ts
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
```

- [ ] **Step 3: Write failing override and fallback tests**

Add these tests before changing production code:

```ts
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
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
node --test --import tsx tests/ai-review-config.test.ts
```

Expected: FAIL because phases still inherit the active model, standard reasoning differs from the matrix, and `max` is discarded by `isReasoning()`.

- [ ] **Step 5: Replace the reasoning-only defaults with phase routes**

In `src/ai-review-config.ts`, replace `DEFAULT_REASONING_BY_DEPTH` with:

```ts
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
```

- [ ] **Step 6: Resolve explicit phase models ahead of defaults**

Update `resolvePhaseConfig()` so a user-supplied model does not inherit the built-in `openai-codex` provider:

```ts
const phaseConfig = config.phases[phase];
const defaultRoute = DEFAULT_ROUTE_BY_DEPTH[config.depth][phase];
const modelConfig = phaseConfig?.model ? phaseConfig : defaultRoute;
const model = resolveModel(ctx, phase, modelConfig, warnings);
const configuredReasoning = phaseConfig?.reasoning ?? defaultRoute.reasoning;
```

Keep the existing capability checks and warning logic below these lines unchanged.

- [ ] **Step 7: Accept `max` from JSON configuration**

Add the final case to `isReasoning()`:

```ts
return value === "off"
  || value === "minimal"
  || value === "low"
  || value === "medium"
  || value === "high"
  || value === "xhigh"
  || value === "max";
```

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
node --test --import tsx tests/ai-review-config.test.ts
npm run check
```

Expected: 7 tests pass and TypeScript reports no errors.

- [ ] **Step 9: Commit the routing implementation**

```bash
git add src/ai-review-config.ts tests/ai-review-config.test.ts
git diff --cached --check
git commit -S -m "feat: route AI review through GPT-5.6 models"
```

Verify the commit reports a good signature with `git log -1 --show-signature`.

### Task 2: Document The New Defaults

**Files:**
- Modify: `tests/smoke.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing documentation contract**

Extend `readme documents direct cli invocation and ref-based PR reviews` with:

```ts
assert.match(readme, /gpt-5\.6-luna/);
assert.match(readme, /gpt-5\.6-terra/);
assert.match(readme, /gpt-5\.6-sol/);
assert.match(readme, /Pi 0\.80\.6/);
```

- [ ] **Step 2: Run the smoke test and verify RED**

Run:

```bash
node --test --import tsx --test-name-pattern="readme documents" tests/smoke.test.ts
```

Expected: FAIL because the README still describes active-model inheritance and contains no GPT-5.6 defaults.

- [ ] **Step 3: Replace the default-model paragraph and example**

In `README.md`, replace the current default sentence with the standard matrix:

```markdown
AI review defaults to `standard` depth and three parallel chapter agents. Standard routing uses `openai-codex/gpt-5.6-luna` at `medium` for scouting, `openai-codex/gpt-5.6-terra` at `high` for chapter agents, `openai-codex/gpt-5.6-sol` at `xhigh` for validation, and Terra at `high` for synthesis. Fast and deep routing use the depth-aware matrix below. Pi 0.80.6 or newer is required to expose these model IDs; older 0.80.x installations fall back to the active Pi model with a warning.
```

Add the approved matrix immediately below it:

```markdown
| Phase | Fast | Standard | Deep |
| --- | --- | --- | --- |
| Scout | Luna `low` | Luna `medium` | Terra `high` |
| Chapter agents | Luna `medium` | Terra `high` | Sol `xhigh` |
| Validation critic | Terra `high` | Sol `xhigh` | Sol `max` |
| Synthesis | Luna `medium` | Terra `high` | Sol `xhigh` |
```

Replace the example `phases` object with concrete overrides:

```json
"phases": {
  "scout": { "provider": "openai-codex", "model": "gpt-5.6-luna", "reasoning": "medium" },
  "chapter": { "provider": "openai-codex", "model": "gpt-5.6-terra", "reasoning": "high" },
  "validation": { "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning": "xhigh" },
  "synthesis": { "provider": "openai-codex", "model": "gpt-5.6-terra", "reasoning": "high" }
}
```

Retain the existing explanation of configuration paths and override precedence.

- [ ] **Step 4: Run documentation tests and verify GREEN**

Run:

```bash
node --test --import tsx tests/smoke.test.ts
```

Expected: 9 tests pass.

- [ ] **Step 5: Commit the documentation**

```bash
git add README.md tests/smoke.test.ts
git diff --cached --check
git commit -S -m "docs: describe GPT-5.6 review defaults"
```

Verify the commit reports a good signature with `git log -1 --show-signature`.

### Task 3: Upgrade And Verify The Local Pi Runtime

**Files:**
- No repository files.

- [ ] **Step 1: Confirm the pre-upgrade state**

Run:

```bash
pi --version
pi --list-models 5.6
```

Expected before upgrade: Pi reports `0.80.3` and no matching models.

- [ ] **Step 2: Upgrade Pi itself**

Run:

```bash
pi update self
```

Expected: Pi upgrades successfully without changing installed extensions.

- [ ] **Step 3: Verify the catalog**

Run:

```bash
pi --version
pi --list-models 5.6
```

Expected: Pi is at least `0.80.6`, and the catalog lists `openai-codex/gpt-5.6-luna`, `openai-codex/gpt-5.6-terra`, and `openai-codex/gpt-5.6-sol` with reasoning support.

### Task 4: Final Verification And Push

**Files:**
- Verify all files changed in Tasks 1 and 2.

- [ ] **Step 1: Run static verification**

```bash
npm run check
npx tsgo --noEmit --allowJs --noUnusedLocals --noUnusedParameters
git diff --check
```

Expected: all commands exit zero with no diagnostics.

- [ ] **Step 2: Run the complete test suite**

```bash
npm test
```

Expected: all tests pass, including packaging and the native macOS shell handshake.

- [ ] **Step 3: Verify dependency and workspace state**

```bash
npm audit --omit=dev
git status --short --branch
```

Expected: zero production vulnerabilities and no uncommitted files. The branch is ahead only by the signed design, plan, implementation, and documentation commits.

- [ ] **Step 4: Verify every new commit signature**

```bash
git log --show-signature origin/cockpit/mlp..HEAD
```

Expected: every local commit reports a good signature.

- [ ] **Step 5: Push the branch**

```bash
git push origin cockpit/mlp
git status --short --branch
```

Expected: local `HEAD` and `origin/cockpit/mlp` match and the worktree remains clean.
