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

test("structured completion decodes exactly one structured tool call as JSON", async () => {
  let observed: any;
  const text = await completeStructuredText({
    ctx: context,
    route,
    systemPrompt: "system",
    input: "input",
    phase: "map.planner",
    depth: "standard",
    structuredOutput: true,
    complete: (async (...args: any[]) => {
      observed = args;
      return {
        stopReason: "toolUse",
        content: [{
          type: "toolCall",
          id: "call-1",
          name: "submit_structured_response",
          arguments: { story: { intent: "trace behavior" }, chapters: [] },
        }],
      };
    }) as any,
  });

  assert.deepEqual(JSON.parse(text), { story: { intent: "trace behavior" }, chapters: [] });
  assert.equal(observed[1].tools.length, 1);
  assert.equal(observed[1].tools[0].name, "submit_structured_response");
  assert.match(observed[1].systemPrompt, /call submit_structured_response exactly once/i);
});

test("structured completion forwards the phase-specific output schema", async () => {
  let observed: any;
  const outputSchema = {
    type: "object",
    required: ["facts"],
    properties: {
      facts: { type: "array", items: { type: "object" } },
    },
  } as any;
  await completeStructuredText({
    ctx: context,
    route,
    systemPrompt: "system",
    input: "input",
    phase: "map.scout",
    depth: "standard",
    structuredOutput: true,
    structuredOutputSchema: outputSchema,
    complete: (async (...args: any[]) => {
      observed = args;
      return {
        stopReason: "toolUse",
        content: [{
          type: "toolCall",
          id: "call-1",
          name: "submit_structured_response",
          arguments: { facts: [] },
        }],
      };
    }) as any,
  });

  assert.deepEqual(observed[1].tools[0].parameters, outputSchema);
});

test("structured completion rejects ambiguous or missing structured tool output", async () => {
  const run = (response: any) => completeStructuredText({
    ctx: context,
    route,
    systemPrompt: "system",
    input: "input",
    phase: "map.planner",
    depth: "standard",
    structuredOutput: true,
    complete: async () => response,
  });

  await assert.rejects(() => run({
    stopReason: "stop",
    content: [{ type: "text", text: "{\"story\":{}}" }],
  }), /structured tool call/i);
  await assert.rejects(() => run({
    stopReason: "toolUse",
    content: [
      { type: "toolCall", name: "submit_structured_response", arguments: { first: true } },
      { type: "toolCall", name: "submit_structured_response", arguments: { second: true } },
    ],
  }), /exactly one/i);
});

test("incomplete structured completion diagnostics include the model stop reason", async () => {
  await assert.rejects(() => completeStructuredText({
    ctx: context,
    route,
    systemPrompt: "system",
    input: "input",
    phase: "map.scout",
    depth: "standard",
    complete: async () => ({ stopReason: "length", content: [{ type: "text", text: "{}" }] }) as any,
  }), /map\.scout did not complete cleanly \(length\)/i);
});

test("provider error diagnostics retain a bounded single-line error message", async () => {
  await assert.rejects(() => completeStructuredText({
    ctx: context,
    route,
    systemPrompt: "system",
    input: "input",
    phase: "map.scout",
    depth: "standard",
    structuredOutput: true,
    complete: async () => ({
      stopReason: "error",
      errorMessage: `provider rejected request\n${"x".repeat(600)}`,
      content: [],
    }) as any,
  }), (error: Error) => {
    assert.match(error.message, /provider rejected request x+/i);
    assert.equal(error.message.includes("\n"), false);
    assert.ok(error.message.length <= 320);
    return true;
  });
});

test("a registry model rejected by the backend retries once on the active Pi model", async () => {
  const calls: string[] = [];
  const activeModel = { provider: "openai-codex", id: "gpt-5.5", reasoning: true } as any;
  const text = await completeStructuredText({
    ctx: { ...context, model: activeModel },
    route,
    systemPrompt: "system",
    input: "input",
    phase: "map.scout",
    depth: "standard",
    structuredOutput: true,
    complete: (async (model: any) => {
      calls.push(model.id);
      if (model.id === route.model.id) {
        return { stopReason: "error", errorMessage: "Codex error: Model not found gpt-5.6-luna", content: [] };
      }
      return {
        stopReason: "toolUse",
        content: [{
          type: "toolCall",
          name: "submit_structured_response",
          arguments: { facts: [] },
        }],
      };
    }) as any,
  });

  assert.equal(text, '{"facts":[]}');
  assert.deepEqual(calls, ["gpt-5.6-luna", "gpt-5.5"]);
});

test("non-routing provider errors are not retried on a different model", async () => {
  let calls = 0;
  await assert.rejects(() => completeStructuredText({
    ctx: { ...context, model: { provider: "openai-codex", id: "gpt-5.5", reasoning: true } },
    route,
    systemPrompt: "system",
    input: "input",
    phase: "map.scout",
    depth: "standard",
    structuredOutput: true,
    complete: (async () => {
      calls += 1;
      return { stopReason: "error", errorMessage: "rate limit exceeded", content: [] };
    }) as any,
  }), /rate limit exceeded/i);
  assert.equal(calls, 1);
});
