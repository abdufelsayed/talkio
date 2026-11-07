/**
 * Thinker Actor
 *
 * Runs the thinker until a step calls no tools. Each step reads the whole
 * timeline, so requests and corrections that arrive while it works reach its
 * next step, and a request the user cancels is dropped without a cancel
 * signal. The thinker's text, tool calls, and tool results go back to the
 * machine, which appends them to the timeline and starts another run for
 * requests the last step did not read.
 *
 * @module agent/actors/thinker
 */

import { fromCallback } from "xstate";

import {
  isLLMProvider,
  type LLMContext,
  type LLMInput,
  type LLMToolCall,
} from "../../providers/types";
import type { Message, TimelineEntry } from "../../types/common";
import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { thinkerSystem } from "../prompts";
import { getConfigNow } from "../time";
import { encodeTimeline } from "../timeline";
import { runTool, toolDefinitions } from "../tools";
import { trace } from "../trace";

/** Bounds a model that keeps calling tools without ever finishing. */
const MAX_THINKER_STEPS = 25;

export interface ThinkerActorInput {
  config: NormalizedAgentConfig;
  thinker: LLMInput;
  runId: string;
  /** The timeline as it is now, read at the start of every step. */
  readTimeline: () => readonly TimelineEntry[];
}

interface StepResult {
  text: string;
  calls: LLMToolCall[];
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] ===
    "function"
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** One model call, settled once the model completes, fails, or the signal aborts. */
function generateStep(
  model: LLMInput,
  messages: Message[],
  tools: LLMContext["tools"],
  signal: AbortSignal,
): Promise<StepResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let tokens = "";
    const sentences: string[] = [];
    const calls: LLMToolCall[] = [];

    const finish = (text?: string) => {
      if (settled) return;
      settled = true;
      resolve({ text: (text ?? (tokens || sentences.join(" "))).trim(), calls });
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(toError(error));
    };
    signal.addEventListener("abort", () => fail(signal.reason), { once: true });

    const ctx: LLMContext = {
      messages,
      tools,
      token: (token) => {
        if (!settled) tokens += token;
      },
      sentence: (sentence) => {
        if (!settled) sentences.push(sentence);
      },
      toolCall: (call) => {
        if (!settled) calls.push(call);
      },
      complete: finish,
      error: fail,
      signal,
    };

    const consume = async (stream: AsyncIterable<string>) => {
      for await (const token of stream) {
        if (settled) return;
        ctx.token(token);
      }
      finish();
    };

    try {
      const result = isLLMProvider(model) ? model.generate(ctx) : model(ctx);
      Promise.resolve(result)
        .then((resolved) => (isAsyncIterable(resolved) ? consume(resolved) : undefined))
        .catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}

export const thinkerActor = fromCallback<MachineEvent, ThinkerActorInput>(({ sendBack, input }) => {
  const { config, thinker, runId, readTimeline } = input;
  const controller = new AbortController();
  const { signal } = controller;
  const now = () => getConfigNow(config);
  const system = thinkerSystem(config.instructions);
  const tools = toolDefinitions(config.tools);

  const run = async () => {
    for (let step = 0; step < MAX_THINKER_STEPS; step++) {
      const entries = readTimeline();
      const messages = encodeTimeline(entries, "thinker");
      trace(config, { type: "thinker:step", data: { runId, step, entries: entries.length } });
      const { text, calls } = await generateStep(thinker, [system, ...messages], tools, signal);
      if (signal.aborted) return;

      if (text) sendBack({ type: "_thinker:text", runId, text, timestamp: now() });
      for (const call of calls) {
        sendBack({
          type: "_thinker:tool-call",
          runId,
          id: call.toolCallId,
          name: call.toolName,
          input: call.input,
          timestamp: now(),
        });
      }
      await Promise.all(
        calls.map(async (call) => {
          const output = await runTool(config.tools, call, messages, signal);
          if (signal.aborted) return;
          sendBack({
            type: "_thinker:tool-result",
            runId,
            id: call.toolCallId,
            name: call.toolName,
            output,
            timestamp: now(),
          });
        }),
      );
      if (signal.aborted) return;

      if (calls.length === 0) {
        sendBack({ type: "_thinker:done", runId, readThrough: entries.length, timestamp: now() });
        return;
      }
    }
    throw new Error(`The thinker stopped after ${MAX_THINKER_STEPS} steps.`);
  };

  run().catch((error: unknown) => {
    if (signal.aborted) return;
    sendBack({ type: "_thinker:error", runId, error: toError(error), timestamp: now() });
  });

  return () => controller.abort();
});
