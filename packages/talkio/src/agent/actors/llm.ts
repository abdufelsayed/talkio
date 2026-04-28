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
import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { clearConfigTimeout, getConfigNow, setConfigTimeout } from "../time";
import { trace } from "../trace";

export const llmActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    messages: Message[];
    abortSignal: AbortSignal;
    turnId: string | null;
    sayFn: (text: string) => void;
    interruptFn: () => void;
    isSpeakingFn: () => boolean;
  }
>(({ sendBack, input }) => {
  const { config, messages, abortSignal, turnId, sayFn, interruptFn, isSpeakingFn } = input;
  const debug = config.debug ?? false;
  const now = () => getConfigNow(config);
  const startedAt = now();

  let isAborted = false;
  let isSettled = false;
  let tokenCount = 0;
  let firstTokenEmitted = false;
  let timeoutId: ReturnType<typeof setConfigTimeout> | null = null;

  const finishWithError = (error: Error) => {
    if (isAborted || isSettled) return;
    isSettled = true;
    isAborted = true;
    if (timeoutId) clearConfigTimeout(config, timeoutId);
    trace(config, {
      type: "llm:error",
      turnId: turnId ?? undefined,
      elapsedMs: now() - startedAt,
      data: { message: error.message },
    });
    sendBack({ type: "_llm:error", error, timestamp: now() });
  };

  const handleAbort = () => {
    if (!isAborted && !isSettled) {
      trace(config, {
        type: "llm:abort",
        turnId: turnId ?? undefined,
        elapsedMs: now() - startedAt,
        data: { tokenCount },
      });
    }
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

  trace(config, {
    type: "llm:start",
    turnId: turnId ?? undefined,
    data: { messageCount: messages.length },
  });

  const timeoutMs = config.timeout?.llmMs;

  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setConfigTimeout(
      config,
      () => {
        if (debug) console.error("[llm-actor] Timeout after", timeoutMs, "ms");
        trace(config, {
          type: "llm:timeout",
          turnId: turnId ?? undefined,
          elapsedMs: now() - startedAt,
          data: { timeoutMs },
        });
        finishWithError(new Error(`LLM timeout after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  }

  const ctx = {
    messages,
    token: (token: string) => {
      if (isAborted || isSettled) return;
      tokenCount++;
      if (!firstTokenEmitted) {
        firstTokenEmitted = true;
        trace(config, {
          type: "llm:first-token",
          turnId: turnId ?? undefined,
          elapsedMs: now() - startedAt,
          data: { length: token.length, preview: token.slice(0, 80) },
        });
      }
      trace(config, {
        type: "llm:token",
        turnId: turnId ?? undefined,
        elapsedMs: now() - startedAt,
        data: {
          index: tokenCount - 1,
          length: token.length,
          preview: token.slice(0, 80),
        },
      });
      sendBack({ type: "_llm:token", token, timestamp: now() });
    },
    sentence: (sentence: string, index: number) => {
      if (isAborted || isSettled) return;
      trace(config, {
        type: "llm:sentence",
        turnId: turnId ?? undefined,
        elapsedMs: now() - startedAt,
        data: { index, length: sentence.length, preview: sentence.slice(0, 120) },
      });
      sendBack({ type: "_llm:sentence", sentence, index, timestamp: now() });
    },
    complete: (fullText: string) => {
      if (isAborted || isSettled) return;
      isSettled = true;
      if (timeoutId) clearConfigTimeout(config, timeoutId);
      trace(config, {
        type: "llm:complete",
        turnId: turnId ?? undefined,
        elapsedMs: now() - startedAt,
        data: { tokenCount, length: fullText.length },
      });
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
    if (!isAborted && !isSettled) {
      trace(config, {
        type: "llm:abort",
        turnId: turnId ?? undefined,
        elapsedMs: now() - startedAt,
        data: { tokenCount },
      });
    }
    isAborted = true;
    if (timeoutId) clearConfigTimeout(config, timeoutId);
    abortSignal.removeEventListener("abort", handleAbort);
  };
});
