/**
 * @talkio/ai-sdk
 *
 * Use any AI SDK language model as talkio's talker or thinker. talkio runs the
 * tools itself, so each call is one model step: the model streams its text and
 * reports the tools it calls, and talkio calls it again with their results.
 *
 * @example
 * ```typescript
 * import { anthropic } from "@ai-sdk/anthropic";
 * import { aiSdk } from "@talkio/ai-sdk";
 * import { createAgent } from "talkio";
 *
 * const agent = createAgent({
 *   stt,
 *   tts,
 *   talker: aiSdk(anthropic("claude-haiku-5-5")),
 *   thinker: aiSdk(anthropic("claude-opus-5-5")),
 *   instructions: "You are Ava, the receptionist at Acme Dental.",
 *   tools: { lookupAppointment, bookAppointment },
 * });
 * ```
 *
 * @packageDocumentation
 */

import {
  jsonSchema,
  streamText,
  tool,
  type FlexibleSchema,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { createLLM, type LLMProvider, type ToolDefinition } from "talkio";

/** Settings passed through to `streamText` on every call. */
export type AISDKSettings = Pick<
  Parameters<typeof streamText>[0],
  "temperature" | "topP" | "maxOutputTokens" | "maxRetries" | "headers" | "providerOptions"
>;

type JSONSchema = Parameters<typeof jsonSchema>[0];

const SCHEMA_SYMBOL = Symbol.for("vercel.ai.schema");

/**
 * talkio's own tools describe their input with plain JSON Schema, which the
 * AI SDK needs wrapped. Zod, Standard Schema, and AI SDK schemas pass through.
 */
function toInputSchema(schema: unknown): FlexibleSchema<unknown> {
  if (typeof schema === "function") return schema as FlexibleSchema<unknown>;
  if (typeof schema === "object" && schema !== null) {
    if (SCHEMA_SYMBOL in schema || "~standard" in schema) {
      return schema as FlexibleSchema<unknown>;
    }
    return jsonSchema(schema as JSONSchema);
  }
  return jsonSchema({ type: "object", properties: {} });
}

/** Tools without `execute`, so the AI SDK reports their calls instead of running them. */
function toToolSet(tools: Record<string, ToolDefinition>): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => [
      name,
      tool({
        description: definition.description,
        inputSchema: toInputSchema(definition.inputSchema),
      }),
    ]),
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Wraps an AI SDK language model as a talkio model. */
export function aiSdk(model: LanguageModel, settings: AISDKSettings = {}): LLMProvider {
  return createLLM({
    name: typeof model === "string" ? model : model.modelId,
    generate: async (ctx) => {
      const tools = Object.keys(ctx.tools).length > 0 ? toToolSet(ctx.tools) : undefined;
      const result = streamText({
        ...settings,
        model,
        messages: ctx.messages as ModelMessage[],
        tools,
        abortSignal: ctx.signal,
      });
      for await (const part of result.fullStream) {
        if (ctx.signal.aborted) return;
        if (part.type === "text-delta") {
          ctx.token(part.text);
        } else if (part.type === "tool-call") {
          ctx.toolCall({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
        } else if (part.type === "error") {
          ctx.error(toError(part.error));
          return;
        }
      }
      if (!ctx.signal.aborted) ctx.complete();
    },
  });
}
