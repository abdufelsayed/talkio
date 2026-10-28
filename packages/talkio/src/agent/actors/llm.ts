/**
 * LLM (Large Language Model) Actor
 *
 * Runs one generation for one AI turn. Every event carries the generation id
 * so the machine can drop output from a generation it already abandoned.
 *
 * A provider that returns a stream of text has each chunk reported as a
 * token and the generation completed when the stream ends.
 *
 * Providers that only stream tokens, or only call `complete`, are split into
 * sentences here. Providers that call `ctx.sentence` themselves take over
 * splitting from that call on. Automatic sentences are emitted a microtask
 * late, so a provider that reports its own sentence in the same tick as the
 * tokens that complete it is never spoken twice.
 *
 * @module agent/actors/llm
 */

import { fromCallback } from "xstate";

import { isLLMProvider, type LLMContext, type LLMResult } from "../../providers/types";
import type { Message } from "../../types/common";
import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { splitAllSentences, splitSentences } from "../segmenter";
import { clearConfigTimeout, getConfigNow, setConfigTimeout } from "../time";
import { trace } from "../trace";

export interface LLMActorInput {
  config: NormalizedAgentConfig;
  messages: Message[];
  abortSignal: AbortSignal;
  turnId: string;
  generationId: string;
  isSpeaking: () => boolean;
  isSpeculative: () => boolean;
  commitment: Promise<boolean>;
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

export const llmActor = fromCallback<MachineEvent, LLMActorInput>(({ sendBack, input }) => {
  const {
    config,
    messages,
    abortSignal,
    turnId,
    generationId,
    isSpeaking,
    isSpeculative,
    commitment,
  } = input;
  const debug = config.debug ?? false;
  const now = () => getConfigNow(config);
  const startedAt = now();

  let settled = false;
  let tokenCount = 0;
  let providerSentences = false;
  let buffered = "";
  let pendingSentences: string[] = [];
  let flushScheduled = false;
  let sentenceIndex = 0;
  let autoSpokenWords: string[] = [];
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

  const emitSentence = (sentence: string, index: number) => {
    traceLLM("llm:sentence", { index, length: sentence.length, preview: sentence.slice(0, 120) });
    sendBack({ type: "_llm:sentence", generationId, sentence, index, timestamp: now() });
  };

  const flushAutomaticSentences = () => {
    flushScheduled = false;
    const sentences = pendingSentences;
    pendingSentences = [];
    if (providerSentences || !isActive()) return;
    for (const sentence of sentences) {
      autoSpokenWords.push(...sentence.split(/\s+/).filter(Boolean));
      emitSentence(sentence, sentenceIndex++);
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

  const handleAbort = () => {
    if (!settled) traceLLM("llm:abort", { tokenCount });
    settled = true;
    clearTimer();
  };

  if (abortSignal.aborted) return () => {};
  abortSignal.addEventListener("abort", handleAbort);

  traceLLM("llm:start", { messageCount: messages.length });

  const timeoutMs = config.timeout?.llmMs;
  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setConfigTimeout(
      config,
      () => {
        if (debug) console.error("[llm-actor] Timeout after", timeoutMs, "ms");
        traceLLM("llm:timeout", { timeoutMs });
        fail(new Error(`LLM timeout after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  }

  const ctx: LLMContext = {
    messages,
    token: (token) => {
      if (!isActive()) return;
      tokenCount++;
      if (tokenCount === 1) {
        traceLLM("llm:first-token", { length: token.length, preview: token.slice(0, 80) });
      }
      traceLLM("llm:token", {
        index: tokenCount - 1,
        length: token.length,
        preview: token.slice(0, 80),
      });
      sendBack({ type: "_llm:token", generationId, token, timestamp: now() });
      if (providerSentences) return;
      const { sentences, rest } = splitSentences(buffered + token);
      buffered = rest;
      if (sentences.length === 0) return;
      pendingSentences.push(...sentences);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flushAutomaticSentences);
      }
    },
    sentence: (sentence, index) => {
      if (!isActive()) return;
      providerSentences = true;
      pendingSentences = [];
      buffered = "";
      const text = unspokenPart(sentence);
      if (text) emitSentence(text, index);
    },
    complete: (text) => {
      if (!isActive()) return;
      const fullText = text ?? "";
      if (!providerSentences) {
        flushAutomaticSentences();
        const remaining = tokenCount > 0 ? buffered : fullText;
        for (const sentence of splitAllSentences(remaining)) {
          emitSentence(sentence, sentenceIndex++);
        }
        buffered = "";
      }
      settled = true;
      clearTimer();
      traceLLM("llm:complete", { tokenCount, length: fullText.length });
      sendBack({ type: "_llm:complete", generationId, fullText, timestamp: now() });
    },
    error: fail,
    say: (text) => {
      if (abortSignal.aborted) return;
      sendBack({ type: "_llm:say", generationId, text, timestamp: now() });
    },
    interrupt: () => {
      if (abortSignal.aborted) return;
      sendBack({ type: "_llm:interrupt", generationId, timestamp: now() });
    },
    isSpeaking,
    isSpeculative,
    turnConfirmed: () => commitment,
    signal: abortSignal,
  };

  const failGeneration = (error: unknown) => {
    if (debug && isActive()) console.error("[llm-actor] Generation failed:", error);
    fail(toError(error));
  };

  const consume = async (stream: AsyncIterable<string>) => {
    for await (const token of stream) {
      if (!isActive()) return;
      ctx.token(token);
    }
    ctx.complete();
  };

  const settle = (result: LLMResult) => {
    if (isAsyncIterable(result)) consume(result).catch(failGeneration);
  };

  try {
    const result = isLLMProvider(config.llm) ? config.llm.generate(ctx) : config.llm(ctx);
    if (isPromiseLike(result)) {
      result.then((resolved) => settle(resolved as LLMResult), failGeneration);
    } else {
      settle(result);
    }
  } catch (error) {
    failGeneration(error);
  }

  return () => {
    if (!settled) traceLLM("llm:abort", { tokenCount });
    settled = true;
    clearTimer();
    abortSignal.removeEventListener("abort", handleAbort);
  };
});
