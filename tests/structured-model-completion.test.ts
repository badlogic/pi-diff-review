import assert from "node:assert/strict";
import test from "node:test";
import { completeStructuredText } from "../src/structured-model-completion.js";

const context = {
  modelRegistry: {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "yes" } }),
  },
  signal: new AbortController().signal,
} as any;

const route = {
  model: { provider: "openai-codex", id: "gpt-5.6-luna" },
  reasoning: "medium" as const,
  modelLabel: "openai-codex/gpt-5.6-luna",
} as any;

test("structured completion forwards reasoning, signal, and phase metadata", async () => {
  let observed: any;
  const text = await completeStructuredText({
    ctx: context,
    route,
    systemPrompt: "system",
    input: "input",
    phase: "map.scout",
    depth: "standard",
    complete: (async (...args: any[]) => {
      observed = args;
      return { stopReason: "stop", content: [{ type: "text", text: '{"ok":true}' }] };
    }) as any,
  });

  assert.equal(text, '{"ok":true}');
  assert.equal(observed[2].reasoning, "medium");
  assert.equal(observed[2].signal, context.signal);
  assert.equal(observed[2].metadata.phase, "map.scout");
});

test("structured completion rejects missing models and incomplete responses", async () => {
  await assert.rejects(() => completeStructuredText({
    ctx: context,
    route: { ...route, model: null },
    systemPrompt: "system",
    input: "input",
    phase: "map.scout",
    depth: "standard",
  }), /No Pi model/);

  await assert.rejects(() => completeStructuredText({
    ctx: context,
    route,
    systemPrompt: "system",
    input: "input",
    phase: "map.scout",
    depth: "standard",
    complete: async () => ({ stopReason: "length", content: [{ type: "text", text: "{}" }] }) as any,
  }), /did not complete cleanly/);
});
