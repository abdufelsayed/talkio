/**
 * VAD (Voice Activity Detection) Actor
 *
 * XState callback actor that handles voice activity detection via the VAD provider.
 * This actor is responsible for:
 * - Starting the VAD provider (if configured)
 * - Receiving audio input chunks from the agent machine
 * - Processing audio through the VAD provider to detect speech
 * - Emitting speech start/end events for turn detection and interruption
 * - Emitting speech probability events for visualization
 * - Handling errors from the VAD provider
 * - Cleaning up the VAD provider when stopped
 *
 * VAD is optional - if not provided, the STT provider's built-in VAD is used
 * as a fallback. A dedicated VAD provider (like Silero) can provide faster
 * interruption detection for better user experience.
 *
 * @module agent/actors/vad
 */

import { fromCallback } from "xstate";

import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { getConfigNow } from "../time";

export const vadActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    abortSignal: AbortSignal;
  }
>(({ sendBack, receive, input }) => {
  const { config, abortSignal } = input;
  const provider = config.vad;
  const debug = config.debug ?? false;
  const now = () => getConfigNow(config);

  if (!provider) return () => {};

  let isAborted = false;

  const handleAbort = () => {
    isAborted = true;
  };

  abortSignal.addEventListener("abort", handleAbort);

  if (abortSignal.aborted) {
    isAborted = true;
    return () => {
      abortSignal.removeEventListener("abort", handleAbort);
    };
  }

  try {
    provider.start({
      speechStart: () => {
        if (isAborted) return;
        sendBack({ type: "_vad:speech-start", timestamp: now() });
      },
      speechEnd: (duration) => {
        if (isAborted) return;
        sendBack({ type: "_vad:speech-end", duration, timestamp: now() });
      },
      speechProbability: (value) => {
        if (isAborted) return;
        sendBack({ type: "_vad:probability", value, timestamp: now() });
      },
      error: (error) => {
        if (isAborted) return;
        sendBack({ type: "_vad:error", error, timestamp: now() });
      },
      signal: abortSignal,
    });
  } catch (error) {
    if (!isAborted) {
      if (debug) console.error("[vad-actor] Error starting provider:", error);
      sendBack({
        type: "_vad:error",
        error: error instanceof Error ? error : new Error(String(error)),
        timestamp: now(),
      });
    }
  }

  receive((event) => {
    if (isAborted) return;
    if (event.type === "_audio:input") {
      try {
        provider.processAudio(event.audio);
      } catch (error) {
        if (!isAborted) {
          if (debug) console.error("[vad-actor] Error processing audio:", error);
          sendBack({
            type: "_vad:error",
            error: error instanceof Error ? error : new Error(String(error)),
            timestamp: now(),
          });
        }
      }
    }
  });

  return () => {
    isAborted = true;
    abortSignal.removeEventListener("abort", handleAbort);
    try {
      provider.stop();
    } catch (error) {
      if (debug) console.error("[vad-actor] Error stopping provider:", error);
    }
  };
});
