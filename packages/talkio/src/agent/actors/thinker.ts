/**
 * Thinker Actor
 *
 * Runs the thinker until a step calls no tools. Each step reads the whole
 * timeline, so requests and corrections that arrive while it works reach its
 * next step, and a request the user cancels is dropped without a cancel
 * signal. Each step's output and tool results go back to the machine, which
 * appends them to the timeline and starts another run for requests the last
 * step did not read.
 *
 * Every model call and tool call is bounded by `timeout.thinkerMs`: a call
 * that never returns would otherwise hold every later request.
 *
 * @module agent/actors/thinker
 */

import { fromCallback } from "xstate";

import type { LLMContext, LLMInput, LLMReasoning, LLMToolCall } from "../../providers/types";
import type { Message, TimelineEntry, ToolResultOutput } from "../../types/common";
import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent, ThinkerStepContent } from "../../types/events";
import { callModel, toError } from "../model";
import { thinkerSystem } from "../prompts";
import { clearConfigTimeout, getConfigNow, setConfigTimeout, type TimeoutHandle } from "../time";
import { thinkerMessages, uniqueCallId, type ThinkerStep } from "../timeline";
import { runTool, toolDefinitions } from "../tools";
import { trace } from "../trace";

/** Bounds a model that keeps calling tools without ever finishing. */
const MAX_THINKER_STEPS = 25;

export const DEFAULT_THINKER_TIMEOUT_MS = 120_000;

export interface ThinkerActorInput {
  config: NormalizedAgentConfig;
  thinker: LLMInput;
  runId: string;
  /** The timeline and the thinker's steps as they are now, read at the start of every step. */
  read: () => { timeline: readonly TimelineEntry[]; steps: readonly ThinkerStep[] };
}

interface StepResult {
  text: string;
  calls: LLMToolCall[];
  reasoning: LLMReasoning[];
}

interface CallLimits {
  config: NormalizedAgentConfig;
  signal: AbortSignal;
  timeoutMs: number;
}

/** One model call, settled once the model completes, fails, times out, or the signal aborts. */
function generateStep(
  model: LLMInput,
  messages: Message[],
  tools: LLMContext["tools"],
  { config, signal, timeoutMs }: CallLimits,
): Promise<StepResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let tokens = "";
    let timer: TimeoutHandle | null = null;
    const sentences: string[] = [];
    const calls: LLMToolCall[] = [];
    const reasoning: LLMReasoning[] = [];

    const settle = () => {
      settled = true;
      if (timer !== null) clearConfigTimeout(config, timer);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (text?: string) => {
      if (settled) return;
      settle();
      resolve({ text: (text ?? (tokens || sentences.join(" "))).trim(), calls, reasoning });
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settle();
      reject(toError(error));
    };
    const onAbort = () => fail(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setConfigTimeout(
        config,
        () => fail(new Error(`Thinker timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }

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
      reasoning: (part) => {
        if (!settled) reasoning.push(part);
      },
      complete: finish,
      error: fail,
      signal,
    };
    callModel(model, ctx, () => !settled, fail);
  });
}

/** Runs a tool, giving it an error result instead once it runs past the timeout. */
async function runToolWithin(
  tools: NormalizedAgentConfig["tools"],
  call: LLMToolCall,
  messages: Message[],
  { config, signal, timeoutMs }: CallLimits,
): Promise<ToolResultOutput> {
  if (timeoutMs <= 0) return runTool(tools, call, messages, signal);
  const controller = new AbortController();
  let timer: TimeoutHandle | undefined;
  const timedOut = new Promise<ToolResultOutput>((resolve) => {
    timer = setConfigTimeout(
      config,
      () => {
        controller.abort(new Error(`${call.toolName} timed out`));
        resolve({ type: "error-text", value: `${call.toolName} timed out after ${timeoutMs}ms.` });
      },
      timeoutMs,
    );
  });
  const onAbort = () => {
    if (timer !== undefined) clearConfigTimeout(config, timer);
    controller.abort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([runTool(tools, call, messages, controller.signal), timedOut]);
  } finally {
    if (timer !== undefined) clearConfigTimeout(config, timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function stepContent(result: StepResult, calls: LLMToolCall[]): ThinkerStepContent {
  return [
    ...result.reasoning.map((part) => ({
      type: "reasoning" as const,
      text: part.text,
      ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
    })),
    ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
    ...calls.map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      ...(call.providerOptions ? { providerOptions: call.providerOptions } : {}),
    })),
  ];
}

/** The step's calls with ids no earlier call on the timeline used. */
function withUniqueIds(calls: LLMToolCall[], timeline: readonly TimelineEntry[]): LLMToolCall[] {
  const used = new Set(timeline.flatMap((entry) => (entry.type === "tool-call" ? [entry.id] : [])));
  return calls.map((call) => {
    const toolCallId = uniqueCallId(call.toolCallId, used);
    used.add(toolCallId);
    return toolCallId === call.toolCallId ? call : { ...call, toolCallId };
  });
}

export const thinkerActor = fromCallback<MachineEvent, ThinkerActorInput>(({ sendBack, input }) => {
  const { config, thinker, runId, read } = input;
  const controller = new AbortController();
  const limits: CallLimits = {
    config,
    signal: controller.signal,
    timeoutMs: config.timeout?.thinkerMs ?? DEFAULT_THINKER_TIMEOUT_MS,
  };
  const { signal } = controller;
  const now = () => getConfigNow(config);
  const system = thinkerSystem(config.instructions);
  const tools = toolDefinitions(config.tools);
  let readThrough = 0;

  const run = async () => {
    for (let step = 0; step < MAX_THINKER_STEPS; step++) {
      const { timeline, steps } = read();
      readThrough = timeline.length;
      const messages = [system, ...thinkerMessages(timeline, steps)];
      trace(config, { type: "thinker:step", data: { runId, step, entries: timeline.length } });
      const result = await generateStep(thinker, messages, tools, limits);
      if (signal.aborted) return;

      const calls = withUniqueIds(result.calls, timeline);
      sendBack({
        type: "_thinker:step",
        runId,
        readThrough,
        content: stepContent(result, calls),
        timestamp: now(),
      });
      await Promise.all(
        calls.map(async (call) => {
          const output = await runToolWithin(config.tools, call, messages, limits);
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
        sendBack({ type: "_thinker:done", runId, readThrough, timestamp: now() });
        return;
      }
    }
    throw new Error(`The thinker stopped after ${MAX_THINKER_STEPS} steps.`);
  };

  run().catch((error: unknown) => {
    if (signal.aborted) return;
    sendBack({
      type: "_thinker:error",
      runId,
      error: toError(error),
      readThrough,
      timestamp: now(),
    });
  });

  return () => controller.abort();
});
