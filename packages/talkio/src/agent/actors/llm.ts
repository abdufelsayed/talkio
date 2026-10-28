/**
 * LLM (Large Language Model) Actor
 *
 * Runs one generation for one AI turn. Every event carries the generation id
 * so the machine can drop output from a generation it already abandoned.
 *
 * @module agent/actors/llm
 */

import { fromCallback } from "xstate";

import { isLLMProvider, type LLMContext } from "../../providers/types";
import type { Message } from "../../types/common";
import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { clearConfigTimeout, getConfigNow, setConfigTimeout } from "../time";
import { trace } from "../trace";

export interface LLMActorInput {
  config: NormalizedAgentConfig;
  messages: Message[];
  abortSignal: AbortSignal;
  turnId: string;
  generationId: string;
  isSpeaking: () => boolean;
}

export const llmActor = fromCallback<MachineEvent, LLMActorInput>(({ sendBack, input }) => {
  const { config, messages, abortSignal, turnId, generationId, isSpeaking } = input;
  const debug = config.debug ?? false;
  const now = () => getConfigNow(config);
  const startedAt = now();

  let settled = false;
  let tokenCount = 0;
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
    },
    sentence: (sentence, index) => {
      if (!isActive()) return;
      traceLLM("llm:sentence", { index, length: sentence.length, preview: sentence.slice(0, 120) });
      sendBack({ type: "_llm:sentence", generationId, sentence, index, timestamp: now() });
    },
    complete: (fullText) => {
      if (!isActive()) return;
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
    signal: abortSignal,
  };

  try {
    if (isLLMProvider(config.llm)) {
      config.llm.generate(messages, ctx);
    } else {
      config.llm(ctx);
    }
  } catch (error) {
    if (debug) console.error("[llm-actor] Error starting generation:", error);
    fail(error instanceof Error ? error : new Error(String(error)));
  }

  return () => {
    if (!settled) traceLLM("llm:abort", { tokenCount });
    settled = true;
    clearTimer();
    abortSignal.removeEventListener("abort", handleAbort);
  };
});
