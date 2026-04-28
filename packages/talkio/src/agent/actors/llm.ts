/**
 * LLM (Large Language Model) Actor
 *
 * XState callback actor that handles response generation via the LLM provider or function.
 * This actor is responsible for:
 * - Invoking the LLM provider's `generate()` method or calling the LLM function
 * - Streaming tokens and sentences as they're generated
 * - Handling filler phrases and acknowledgments via `ctx.say()`
 * - Supporting interruption of current speech via `ctx.interrupt()`
 * - Emitting events for tokens, sentences, completion, and errors
 *
 * The actor receives the conversation history (messages) and an abort signal
 * for cancellation. It provides the LLM context with methods to report
 * generation progress and control speech playback.
 *
 * @module agent/actors/llm
 */

import { fromCallback } from "xstate";

import { isLLMProvider } from "../../providers/types";
import type { Message } from "../../types/common";
import type { AgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { clearConfigTimeout, getConfigNow, setConfigTimeout } from "../time";

export const llmActor = fromCallback<
  MachineEvent,
  {
    config: AgentConfig;
    messages: Message[];
    abortSignal: AbortSignal;
    sayFn: (text: string) => void;
    interruptFn: () => void;
    isSpeakingFn: () => boolean;
  }
>(({ sendBack, input }) => {
  const { config, messages, abortSignal, sayFn, interruptFn, isSpeakingFn } = input;
  const debug = config.debug ?? false;
  const now = () => getConfigNow(config);

  let isAborted = false;
  let isSettled = false;
  let timeoutId: ReturnType<typeof setConfigTimeout> | null = null;

  const finishWithError = (error: Error) => {
    if (isAborted || isSettled) return;
    isSettled = true;
    isAborted = true;
    if (timeoutId) clearConfigTimeout(config, timeoutId);
    sendBack({ type: "_llm:error", error, timestamp: now() });
  };

  const handleAbort = () => {
    isAborted = true;
  };

  abortSignal.addEventListener("abort", handleAbort);

  // Check if already aborted before starting
  if (abortSignal.aborted) {
    isAborted = true;
    return () => {
      abortSignal.removeEventListener("abort", handleAbort);
    };
  }

  const timeoutMs = config.timeout?.llmMs;

  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setConfigTimeout(
      config,
      () => {
        if (debug) console.error("[llm-actor] Timeout after", timeoutMs, "ms");
        finishWithError(new Error(`LLM timeout after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  }

  const ctx = {
    messages,
    token: (token: string) => {
      if (isAborted || isSettled) return;
      sendBack({ type: "_llm:token", token, timestamp: now() });
    },
    sentence: (sentence: string, index: number) => {
      if (isAborted || isSettled) return;
      sendBack({ type: "_llm:sentence", sentence, index, timestamp: now() });
    },
    complete: (fullText: string) => {
      if (isAborted || isSettled) return;
      isSettled = true;
      if (timeoutId) clearConfigTimeout(config, timeoutId);
      sendBack({ type: "_llm:complete", fullText, timestamp: now() });
    },
    error: (error: Error) => {
      finishWithError(error);
    },
    say: sayFn,
    interrupt: interruptFn,
    isSpeaking: isSpeakingFn,
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
    finishWithError(error instanceof Error ? error : new Error(String(error)));
  }

  return () => {
    isAborted = true;
    if (timeoutId) clearConfigTimeout(config, timeoutId);
    abortSignal.removeEventListener("abort", handleAbort);
  };
});
