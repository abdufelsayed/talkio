/**
 * Turn Detector Actor
 *
 * XState callback actor that handles turn detection via the turn detector provider.
 * This actor is responsible for:
 * - Starting the turn detector provider (if configured)
 * - Receiving transcript updates from the STT provider
 * - Receiving speech end events from VAD
 * - Analyzing transcripts and speech patterns to detect turn boundaries
 * - Emitting turn end events when the user has finished speaking
 * - Emitting turn abandoned events for short/noise turns
 * - Handling errors from the turn detector provider
 * - Cleaning up the turn detector provider when stopped
 *
 * Turn detection is optional - if not provided, the STT provider's final
 * transcript marks the turn end. A dedicated turn detector can provide
 * faster or more sophisticated turn detection (e.g., semantic analysis).
 *
 * @module agent/actors/turn-detector
 */

import { fromCallback } from "xstate";

import type { AgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { getConfigNow } from "../time";

export const turnDetectorActor = fromCallback<
  MachineEvent,
  {
    config: AgentConfig;
    abortSignal: AbortSignal;
  }
>(({ sendBack, receive, input }) => {
  const { config, abortSignal } = input;
  const provider = config.turnDetector;
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
      turnEnd: (transcript) => {
        if (isAborted) return;
        sendBack({ type: "_turn:end", transcript, timestamp: now() });
      },
      turnAbandoned: (reason) => {
        if (isAborted) return;
        sendBack({ type: "_turn:abandoned", reason, timestamp: now() });
      },
      signal: abortSignal,
    });
  } catch (error) {
    if (!isAborted && debug) {
      console.error("[turn-detector-actor] Error starting provider:", error);
    }
  }

  receive((event) => {
    if (isAborted) return;
    try {
      if (event.type === "_stt:transcript") {
        provider.onTranscript(event.text, event.isFinal);
      } else if (event.type === "_vad:speech-end") {
        provider.onSpeechEnd(event.duration);
      }
    } catch (error) {
      if (!isAborted && debug) {
        console.error("[turn-detector-actor] Error processing event:", error);
      }
    }
  });

  return () => {
    isAborted = true;
    abortSignal.removeEventListener("abort", handleAbort);
    try {
      provider.stop();
    } catch (error) {
      if (debug) console.error("[turn-detector-actor] Error stopping provider:", error);
    }
  };
});
