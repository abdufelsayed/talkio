/**
 * Talker Actor
 *
 * Runs one talker turn: the talker model, then again with the results of the
 * tools it called, until a step calls none. Its only tool is `think`, which
 * is reported to the machine as soon as the model calls it and answered with
 * "Started." so the talker can tell the user it is on it. Every event carries
 * the generation id so the machine can drop output from a turn it abandoned.
 *
 * A provider that returns a stream of text has each chunk reported as a
 * token and the step completed when the stream ends.
 *
 * Providers that only stream tokens, or only call `complete`, are split into
 * sentences here. Providers that call `ctx.sentence` themselves take over
 * splitting for the rest of the step from that call on. Automatic sentences
 * are emitted a microtask late, so a provider that reports its own sentence in
 * the same tick as the tokens that complete it is never spoken twice.
 *
 * @module agent/actors/llm
 */

import { fromCallback } from "xstate";

import {
  isLLMProvider,
  type LLMContext,
  type LLMResult,
  type LLMToolCall,
  type ToolDefinition,
} from "../../providers/types";
import type { Message, ToolResultOutput } from "../../types/common";
import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { splitAllSentences, splitSentences } from "../segmenter";
import { clearConfigTimeout, getConfigNow, setConfigTimeout } from "../time";
import { THINK_TOOL_NAME } from "../timeline";
import { trace } from "../trace";

/** Enough for a reply that calls `think` and a reply after it, with room for one retry. */
const MAX_TALKER_STEPS = 3;

export interface LLMActorInput {
  config: NormalizedAgentConfig;
  messages: Message[];
  tools: Record<string, ToolDefinition>;
  abortSignal: AbortSignal;
  turnId: string;
  generationId: string;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
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

function thinkRequest(input: unknown): string {
  const request = (input as { request?: unknown } | null)?.request;
  return typeof request === "string" ? request.trim() : "";
}

/** What the talker sees as the result of each tool it called. */
function toolOutput(call: LLMToolCall, tools: Record<string, ToolDefinition>): ToolResultOutput {
  if (call.toolName !== THINK_TOOL_NAME || !Object.hasOwn(tools, THINK_TOOL_NAME)) {
    return { type: "error-text", value: `Unknown tool: ${call.toolName}` };
  }
  return thinkRequest(call.input)
    ? { type: "text", value: "Started." }
    : { type: "error-text", value: "think needs a request." };
}

function nextStepMessages(
  messages: Message[],
  text: string,
  calls: LLMToolCall[],
  tools: Record<string, ToolDefinition>,
): Message[] {
  return [
    ...messages,
    {
      role: "assistant",
      content: [
        ...(text.trim() ? [{ type: "text" as const, text }] : []),
        ...calls.map((call) => ({ type: "tool-call" as const, ...call })),
      ],
    },
    {
      role: "tool",
      content: calls.map((call) => ({
        type: "tool-result" as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: toolOutput(call, tools),
      })),
    },
  ];
}

export const llmActor = fromCallback<MachineEvent, LLMActorInput>(({ sendBack, input }) => {
  const { config, tools, abortSignal, turnId, generationId } = input;
  const canThink = Object.hasOwn(tools, THINK_TOOL_NAME);
  const debug = config.debug ?? false;
  const now = () => getConfigNow(config);
  const startedAt = now();

  let settled = false;
  let tokenCount = 0;
  let sentenceIndex = 0;
  let fullText = "";
  let timeoutId: ReturnType<typeof setConfigTimeout> | null = null;

  const isActive = () => !settled && !abortSignal.aborted;

  const clearTimer = () => {
    if (timeoutId !== null) clearConfigTimeout(config, timeoutId);
    timeoutId = null;
  };

  const traceLLM = (type: string, data?: Record<string, unknown>) =>
    trace(config, { type, turnId, elapsedMs: now() - startedAt, data });

  const fail = (error: Error) => {
    if (!isActive()) return;
    settled = true;
    clearTimer();
    traceLLM("llm:error", { message: error.message });
    sendBack({ type: "_llm:error", generationId, error, timestamp: now() });
  };

  const failGeneration = (error: unknown) => {
    if (debug && isActive()) console.error("[llm-actor] Generation failed:", error);
    fail(toError(error));
  };

  const emitSentence = (sentence: string) => {
    const index = sentenceIndex++;
    traceLLM("llm:sentence", { index, length: sentence.length, preview: sentence.slice(0, 120) });
    sendBack({ type: "_llm:sentence", generationId, sentence, index, timestamp: now() });
  };

  const runStep = (messages: Message[], step: number) => {
    let stepSettled = false;
    let providerSentences = false;
    let buffered = "";
    let pendingSentences: string[] = [];
    let flushScheduled = false;
    let autoSpokenWords: string[] = [];
    let stepTokens = "";
    const stepSentences: string[] = [];
    const calls: LLMToolCall[] = [];
    // Steps are parts of one reply, so their text must not run together.
    let needsSeparator = fullText !== "" && !/\s$/.test(fullText);

    const stepActive = () => !stepSettled && isActive();

    const speak = (sentence: string) => {
      stepSentences.push(sentence);
      emitSentence(sentence);
    };

    const flushAutomaticSentences = () => {
      flushScheduled = false;
      const sentences = pendingSentences;
      pendingSentences = [];
      if (providerSentences || !isActive()) return;
      for (const sentence of sentences) {
        autoSpokenWords.push(...sentence.split(/\s+/).filter(Boolean));
        speak(sentence);
      }
    };

    /** Drops the part of a provider sentence that automatic splitting already spoke. */
    const unspokenPart = (sentence: string): string => {
      if (autoSpokenWords.length === 0) return sentence.trim();
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      let shared = 0;
      while (
        shared < words.length &&
        shared < autoSpokenWords.length &&
        words[shared] === autoSpokenWords[shared]
      ) {
        shared++;
      }
      autoSpokenWords = shared < words.length ? [] : autoSpokenWords.slice(shared);
      return words.slice(shared).join(" ");
    };

    traceLLM(step === 0 ? "llm:start" : "llm:step", { step, messageCount: messages.length });

    const ctx: LLMContext = {
      messages,
      tools,
      token: (token) => {
        if (!stepActive()) return;
        let text = token;
        if (needsSeparator && text) {
          needsSeparator = false;
          if (!/^\s/.test(text)) text = ` ${text}`;
        }
        stepTokens += text;
        tokenCount++;
        if (tokenCount === 1) {
          traceLLM("llm:first-token", { length: text.length, preview: text.slice(0, 80) });
        }
        traceLLM("llm:token", {
          index: tokenCount - 1,
          length: text.length,
          preview: text.slice(0, 80),
        });
        sendBack({ type: "_llm:token", generationId, token: text, timestamp: now() });
        if (providerSentences) return;
        const { sentences, rest } = splitSentences(buffered + text);
        buffered = rest;
        if (sentences.length === 0) return;
        pendingSentences.push(...sentences);
        if (!flushScheduled) {
          flushScheduled = true;
          queueMicrotask(flushAutomaticSentences);
        }
      },
      sentence: (sentence) => {
        if (!stepActive()) return;
        providerSentences = true;
        pendingSentences = [];
        buffered = "";
        const text = unspokenPart(sentence);
        if (text) speak(text);
      },
      toolCall: (call) => {
        if (!stepActive()) return;
        calls.push(call);
        traceLLM("llm:tool-call", { name: call.toolName });
        const request =
          canThink && call.toolName === THINK_TOOL_NAME ? thinkRequest(call.input) : "";
        if (request) {
          sendBack({
            type: "_llm:think",
            generationId,
            id: call.toolCallId,
            request,
            timestamp: now(),
          });
        }
      },
      complete: (text) => {
        if (!stepActive()) return;
        if (!providerSentences) {
          flushAutomaticSentences();
          const remaining = stepTokens !== "" ? buffered : (text ?? "");
          for (const sentence of splitAllSentences(remaining)) speak(sentence);
          buffered = "";
        }
        stepSettled = true;
        const stepText = (text ?? (stepTokens || stepSentences.join(" "))).trim();
        fullText = [fullText, stepText].filter(Boolean).join(" ");
        if (calls.length > 0 && step + 1 < MAX_TALKER_STEPS) {
          runStep(nextStepMessages(messages, stepText, calls, tools), step + 1);
          return;
        }
        settled = true;
        clearTimer();
        traceLLM("llm:complete", { tokenCount, length: fullText.length, steps: step + 1 });
        sendBack({ type: "_llm:complete", generationId, fullText, timestamp: now() });
      },
      error: fail,
      signal: abortSignal,
    };

    const consume = async (stream: AsyncIterable<string>) => {
      for await (const token of stream) {
        if (!stepActive()) return;
        ctx.token(token);
      }
      ctx.complete();
    };

    const settle = (result: LLMResult) => {
      if (isAsyncIterable(result)) consume(result).catch(failGeneration);
    };

    try {
      const result = isLLMProvider(config.talker)
        ? config.talker.generate(ctx)
        : config.talker(ctx);
      if (isPromiseLike(result)) {
        result.then((resolved) => settle(resolved as LLMResult), failGeneration);
      } else {
        settle(result);
      }
    } catch (error) {
      failGeneration(error);
    }
  };

  const handleAbort = () => {
    if (!settled) traceLLM("llm:abort", { tokenCount });
    settled = true;
    clearTimer();
  };

  if (abortSignal.aborted) return () => {};
  abortSignal.addEventListener("abort", handleAbort);

  const timeoutMs = config.timeout?.talkerMs;
  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setConfigTimeout(
      config,
      () => {
        if (debug) console.error("[llm-actor] Timeout after", timeoutMs, "ms");
        traceLLM("llm:timeout", { timeoutMs });
        fail(new Error(`Talker timeout after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  }

  runStep(input.messages, 0);

  return () => {
    if (!settled) traceLLM("llm:abort", { tokenCount });
    settled = true;
    clearTimer();
    abortSignal.removeEventListener("abort", handleAbort);
  };
});
