import { completeSimple, type Tool, type ToolCall, type UserMessage } from "@earendil-works/pi-ai/compat";
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
  structuredOutput?: boolean;
  structuredOutputSchema?: Tool["parameters"];
  complete?: CompletionDriver;
}

const STRUCTURED_OUTPUT_TOOL_NAME = "submit_structured_response";

function structuredOutputTool(schema?: Tool["parameters"]): Tool {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: "Submit the complete structured response required by the system prompt.",
    parameters: schema ?? ({ type: "object", additionalProperties: true } as unknown as Tool["parameters"]),
  };
}

function completionStopDetail(response: { stopReason: string; errorMessage?: string }): string {
  const errorMessage = response.errorMessage?.replace(/\s+/g, " ").trim().slice(0, 240);
  return `${response.stopReason}${errorMessage ? `: ${errorMessage}` : ""}`;
}

export async function completeStructuredText(options: CompleteStructuredTextOptions): Promise<string> {
  const model = options.route.model;
  if (!model) throw new Error(`No Pi model is selected for ${options.phase}.`);
  const userMessage: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: options.input }],
  };
  const context = {
    systemPrompt: options.structuredOutput
      ? `${options.systemPrompt}\nCall ${STRUCTURED_OUTPUT_TOOL_NAME} exactly once with the complete response object. Do not emit the JSON as text.`
      : options.systemPrompt,
    messages: [userMessage],
    ...(options.structuredOutput ? { tools: [structuredOutputTool(options.structuredOutputSchema)] } : {}),
  };
  const run = async (
    selectedModel: NonNullable<AiReviewRuntimePhaseConfig["model"]>,
    reasoning: AiReviewRuntimePhaseConfig["reasoning"],
  ) => {
    const auth = await options.ctx.modelRegistry.getApiKeyAndHeaders(selectedModel);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? `No API key for ${selectedModel.provider}.` : auth.error);
    }
    return await (options.complete ?? completeSimple)(selectedModel, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      ...(reasoning ? { reasoning } : {}),
      ...(options.ctx.signal ? { signal: options.ctx.signal } : {}),
      metadata: {
        feature: "pi-diff-review-cockpit",
        phase: options.phase,
        depth: options.depth,
      },
    });
  };
  let response = await run(model, options.route.reasoning);
  const fallbackModel = options.ctx.model;
  if (response.stopReason === "error"
    && /model\s+not\s+found/i.test(response.errorMessage ?? "")
    && fallbackModel != null
    && (fallbackModel.provider !== model.provider || fallbackModel.id !== model.id)) {
    response = await run(fallbackModel, fallbackModel.reasoning ? options.route.reasoning : undefined);
  }
  if (options.structuredOutput) {
    const toolCalls = response.content.filter((part): part is ToolCall => part.type === "toolCall");
    const matchingCalls = toolCalls.filter((part) => part.name === STRUCTURED_OUTPUT_TOOL_NAME);
    if (response.stopReason !== "toolUse") {
      throw new Error(`${options.phase} did not produce the required structured tool call (${completionStopDetail(response)}).`);
    }
    if (toolCalls.length !== 1 || matchingCalls.length !== 1) {
      throw new Error(`${options.phase} must produce exactly one ${STRUCTURED_OUTPUT_TOOL_NAME} tool call.`);
    }
    const argumentsValue = matchingCalls[0]!.arguments;
    if (argumentsValue == null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
      throw new Error(`${options.phase} structured tool arguments must be an object.`);
    }
    return JSON.stringify(argumentsValue);
  }
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (response.stopReason !== "stop" || text.length === 0) {
    throw new Error(`${options.phase} did not complete cleanly (${completionStopDetail(response)}).`);
  }
  return text;
}
