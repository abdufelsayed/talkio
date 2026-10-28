/**
 * TTS (Text-to-Speech) Actor
 *
 * Long-lived actor that owns a TTS provider session. It receives speak and
 * clear commands from the agent machine and maps provider callbacks back into
 * request-scoped machine events.
 *
 * @module agent/actors/tts
 */

import { fromCallback } from "xstate";

import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { clearConfigTimeout, getConfigNow, setConfigTimeout } from "../time";
import { trace } from "../trace";

export const ttsActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    abortSignal: AbortSignal;
  }
>(({ sendBack, receive, input }) => {
  const { config, abortSignal } = input;
  const provider = config.tts;
  const outputFormat = config.audio.output;
  const debug = config.debug ?? false;
  const now = () => getConfigNow(config);

  let activeRequestId: string | null = null;
  let activeTurnId: string | undefined;
  let activeRequestText = "";
  let activeStartedAt = 0;
  let isAborted = false;
  let chunkCount = 0;
  let totalBytes = 0;
  let firstAudioEmitted = false;
  let timeoutId: ReturnType<typeof setConfigTimeout> | null = null;

  const clearRequestTimeout = () => {
    if (timeoutId) {
      clearConfigTimeout(config, timeoutId);
      timeoutId = null;
    }
  };

  const clearActiveRequest = () => {
    clearRequestTimeout();
    activeRequestId = null;
    activeTurnId = undefined;
    activeRequestText = "";
    activeStartedAt = 0;
    chunkCount = 0;
    totalBytes = 0;
    firstAudioEmitted = false;
  };

  const finishWithError = (error: Error) => {
    if (isAborted || activeRequestId === null) return;
    const requestId = activeRequestId;
    trace(config, {
      type: "tts:error",
      turnId: activeTurnId,
      requestId,
      elapsedMs: now() - activeStartedAt,
      data: { message: error.message },
    });
    clearActiveRequest();
    sendBack({ type: "_tts:error", requestId, error, timestamp: now() });
  };

  const startRequestTimeout = (requestId: string) => {
    clearRequestTimeout();
    const timeoutMs = config.timeout?.ttsMs;
    if (!timeoutMs || timeoutMs <= 0) return;

    timeoutId = setConfigTimeout(
      config,
      () => {
        if (activeRequestId !== requestId) return;
        if (debug) console.error("[tts-actor] Timeout after", timeoutMs, "ms");
        try {
          provider.clear();
        } catch (error) {
          if (debug) console.error("[tts-actor] Error clearing timed out provider:", error);
        }
        finishWithError(new Error(`TTS timeout after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
  };

  const handleAbort = () => {
    if (!isAborted && activeRequestId !== null) {
      trace(config, {
        type: "tts:abort",
        turnId: activeTurnId,
        requestId: activeRequestId,
        elapsedMs: now() - activeStartedAt,
        data: { chunkCount, totalBytes },
      });
    }
    isAborted = true;
    clearActiveRequest();
    try {
      provider.stop();
    } catch (error) {
      if (debug) console.error("[tts-actor] Error stopping provider:", error);
    }
  };

  abortSignal.addEventListener("abort", handleAbort);

  if (abortSignal.aborted) {
    handleAbort();
    return () => {
      abortSignal.removeEventListener("abort", handleAbort);
    };
  }

  try {
    provider.start({
      audioFormat: outputFormat,
      audio: (audio) => {
        if (isAborted || activeRequestId === null) return;
        chunkCount++;
        totalBytes += audio.byteLength;
        if (!firstAudioEmitted) {
          firstAudioEmitted = true;
          trace(config, {
            type: "tts:first-audio",
            turnId: activeTurnId,
            requestId: activeRequestId,
            elapsedMs: now() - activeStartedAt,
            data: { bytes: audio.byteLength },
          });
        }
        trace(config, {
          type: "tts:chunk",
          turnId: activeTurnId,
          requestId: activeRequestId,
          elapsedMs: now() - activeStartedAt,
          data: { index: chunkCount - 1, bytes: audio.byteLength, totalBytes },
        });
        sendBack({ type: "_tts:chunk", requestId: activeRequestId, audio, timestamp: now() });
      },
      wordTimings: (words) => {
        if (isAborted || activeRequestId === null || words.length === 0) return;
        sendBack({ type: "_tts:words", requestId: activeRequestId, words, timestamp: now() });
      },
      complete: () => {
        if (isAborted || activeRequestId === null) return;
        const requestId = activeRequestId;
        trace(config, {
          type: "tts:complete",
          turnId: activeTurnId,
          requestId,
          elapsedMs: now() - activeStartedAt,
          data: { chunkCount, totalBytes },
        });
        clearActiveRequest();
        sendBack({ type: "_tts:complete", requestId, timestamp: now() });
      },
      error: finishWithError,
      signal: abortSignal,
    });
  } catch (error) {
    if (debug) console.error("[tts-actor] Error starting provider:", error);
    finishWithError(error instanceof Error ? error : new Error(String(error)));
  }

  receive((event) => {
    if (isAborted) return;

    if (event.type === "_tts:speak") {
      activeRequestId = event.requestId;
      activeTurnId = event.turnId;
      activeRequestText = event.text;
      activeStartedAt = now();
      chunkCount = 0;
      totalBytes = 0;
      firstAudioEmitted = false;
      trace(config, {
        type: "tts:start",
        turnId: activeTurnId,
        requestId: event.requestId,
        data: { length: event.text.length, preview: event.text.slice(0, 120) },
      });
      startRequestTimeout(event.requestId);
      try {
        provider.speak(event.text, { requestId: event.requestId });
        provider.flush({ requestId: event.requestId });
      } catch (error) {
        finishWithError(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    if (event.type === "_tts:clear") {
      if (activeRequestId !== null) {
        trace(config, {
          type: "tts:clear",
          turnId: activeTurnId,
          requestId: activeRequestId,
          elapsedMs: now() - activeStartedAt,
          data: { chunkCount, totalBytes, length: activeRequestText.length },
        });
      }
      clearActiveRequest();
      try {
        provider.clear();
      } catch (error) {
        if (debug) console.error("[tts-actor] Error clearing provider:", error);
      }
    }
  });

  return () => {
    handleAbort();
    abortSignal.removeEventListener("abort", handleAbort);
  };
});
