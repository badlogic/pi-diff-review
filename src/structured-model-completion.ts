import { completeSimple, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AiReviewDepth, AiReviewRuntimePhaseConfig } from "./types.js";

type CompletionDriver = typeof completeSimple;

export interface CompleteStructuredTextOptions {
  ctx: ExtensionCommandContext;
  route: AiReviewRuntimePhaseConfig;
  systemPrompt: string;
  input: string;
  phase: string;
  depth: AiReviewDepth;
  complete?: CompletionDriver;
}

export async function completeStructuredText(options: CompleteStructuredTextOptions): Promise<string> {
  const model = options.route.model;
  if (!model) throw new Error(`No Pi model is selected for ${options.phase}.`);

  const auth = await options.ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}.` : auth.error);
  }
  const userMessage: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: options.input }],
  };
  const response = await (options.complete ?? completeSimple)(
    model,
    { systemPrompt: options.systemPrompt, messages: [userMessage] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      ...(options.route.reasoning ? { reasoning: options.route.reasoning } : {}),
      ...(options.ctx.signal ? { signal: options.ctx.signal } : {}),
      metadata: {
        feature: "pi-diff-review-cockpit",
        phase: options.phase,
        depth: options.depth,
      },
    },
  );
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (response.stopReason !== "stop" || text.length === 0) {
    throw new Error(`${options.phase} did not complete cleanly.`);
  }
  return text;
}
