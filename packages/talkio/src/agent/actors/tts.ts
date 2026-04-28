/**
 * TTS (Text-to-Speech) Actor
 *
 * XState callback actor that handles speech synthesis via the TTS provider.
 * This actor is responsible for:
 * - Invoking the TTS provider's `synthesize()` method with the text to speak
 * - Receiving audio chunks as they're produced by the TTS provider
 * - Emitting audio chunk events for streaming playback
 * - Emitting completion events when synthesis finishes
 * - Handling errors from the TTS provider
 * - Respecting abort signals for cancellation
 *
 * The actor receives the text to synthesize, and the
 * configured output audio format. It streams audio chunks in real-time,
 * enabling low-latency playback while the TTS provider continues generating audio.
 *
 * @module agent/actors/tts
 */

import { fromCallback } from "xstate";

import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { clearConfigTimeout, getConfigNow, setConfigTimeout } from "../time";

export const ttsActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    text: string;
    requestId: string;
    abortSignal: AbortSignal;
  }
>(({ sendBack, input }) => {
  const { config, text, requestId, abortSignal } = input;
  const provider = config.tts;
  const outputFormat = config.audio.output;
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
    sendBack({ type: "_tts:error", requestId, error, timestamp: now() });
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

  const timeoutMs = config.timeout?.ttsMs;

  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setConfigTimeout(
      config,
      () => {
        if (debug) console.error("[tts-actor] Timeout after", timeoutMs, "ms");
        finishWithError(new Error(`TTS timeout after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  }

  try {
    provider.synthesize(text, {
      audioFormat: outputFormat,
      audioChunk: (audio) => {
        if (isAborted || isSettled) return;
        sendBack({ type: "_tts:chunk", requestId, audio, timestamp: now() });
      },
      complete: () => {
        if (isAborted || isSettled) return;
        isSettled = true;
        if (timeoutId) clearConfigTimeout(config, timeoutId);
        sendBack({ type: "_tts:complete", requestId, timestamp: now() });
      },
      error: (error) => {
        finishWithError(error);
      },
      signal: abortSignal,
    });
  } catch (error) {
    if (debug) console.error("[tts-actor] Error starting synthesis:", error);
    finishWithError(error instanceof Error ? error : new Error(String(error)));
  }

  return () => {
    isAborted = true;
    if (timeoutId) clearConfigTimeout(config, timeoutId);
    abortSignal.removeEventListener("abort", handleAbort);
  };
});
