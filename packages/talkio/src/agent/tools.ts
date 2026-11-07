/**
 * Tool Execution
 *
 * Runs the tools the thinker calls. A tool never fails the thinker: an
 * unknown tool, a thrown error, or an output that is not JSON becomes an
 * error result the thinker reads and can work around.
 *
 * @module agent/tools
 */

import type { LLMToolCall, Tool, ToolDefinition } from "../providers/types";
import type { Message, ToolResultOutput } from "../types/common";

/** What the model sees of each tool: everything but `execute`. */
export function toolDefinitions(tools: Record<string, Tool>): Record<string, ToolDefinition> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      { description: tool.description, inputSchema: tool.inputSchema },
    ]),
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] ===
    "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A tool's return value as a result the model reads. */
export function toolResultOutput(value: unknown): ToolResultOutput {
  if (typeof value === "string") return { type: "text", value };
  if (value === undefined) return { type: "json", value: null };
  return { type: "json", value: JSON.parse(JSON.stringify(value)) };
}

export async function runTool(
  tools: Record<string, Tool>,
  call: LLMToolCall,
  messages: Message[],
  abortSignal: AbortSignal,
): Promise<ToolResultOutput> {
  const tool = Object.hasOwn(tools, call.toolName) ? tools[call.toolName] : undefined;
  if (!tool) return { type: "error-text", value: `Unknown tool: ${call.toolName}` };
  if (!tool.execute) {
    return { type: "error-text", value: `${call.toolName} has no execute function.` };
  }
  try {
    const returned = tool.execute(call.input as never, {
      toolCallId: call.toolCallId,
      messages,
      abortSignal,
    });
    let value: unknown;
    if (isAsyncIterable(returned)) {
      for await (const item of returned) value = item;
    } else {
      value = await returned;
    }
    return toolResultOutput(value);
  } catch (error) {
    return { type: "error-text", value: errorMessage(error) };
  }
}
