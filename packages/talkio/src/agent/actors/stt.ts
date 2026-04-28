/**
 * STT (Speech-to-Text) Actor
 *
 * XState callback actor that handles speech recognition via the STT provider.
 * This actor is responsible for:
 * - Starting the STT provider with the configured audio format
 * - Receiving audio input chunks from the agent machine
 * - Forwarding audio to the STT provider for transcription
 * - Emitting transcript events (partial and final) as they arrive
 * - Emitting VAD events (speech start/end) if the STT provider supports them
 * - Handling errors from the STT provider
 * - Cleaning up the STT provider when stopped
 *
 * The actor acts as a bridge between the agent state machine and the STT provider,
 * translating audio input into transcript events that drive the conversation flow.
 *
 * @module agent/actors/stt
 */

import { fromCallback } from "xstate";

import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";

export const sttActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    abortSignal: AbortSignal;
  }
>(({ sendBack, receive, input }) => {
  const { config, abortSignal } = input;
  const provider = config.stt;
  const inputFormat = config.audio.input;
  const debug = config.debug ?? false;
  let audioChunksReceived = 0;
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

  if (debug) console.log("[stt-actor] Starting STT provider with format:", inputFormat);

  try {
    provider.start({
      audioFormat: inputFormat,
      transcript: (text, isFinal) => {
        if (isAborted) return;
        if (debug) console.log("[stt-actor] Transcript:", text, "final:", isFinal);
        sendBack({ type: "_stt:transcript", text, isFinal, timestamp: Date.now() });
      },
      speechStart: () => {
        if (isAborted) return;
        if (debug) console.log("[stt-actor] Speech start detected");
        sendBack({ type: "_stt:speech-start", timestamp: Date.now() });
      },
      speechEnd: () => {
        if (isAborted) return;
        if (debug) console.log("[stt-actor] Speech end detected");
        sendBack({ type: "_stt:speech-end", timestamp: Date.now() });
      },
      error: (error) => {
        if (isAborted) return;
        if (debug) console.error("[stt-actor] Error:", error.message);
        sendBack({ type: "_stt:error", error, timestamp: Date.now() });
      },
      signal: abortSignal,
    });
  } catch (error) {
    if (!isAborted) {
      if (debug) console.error("[stt-actor] Error starting provider:", error);
      sendBack({
        type: "_stt:error",
        error: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now(),
      });
    }
  }

  receive((event) => {
    if (isAborted) return;
    if (event.type === "_audio:input") {
      audioChunksReceived++;
      if (debug && audioChunksReceived % 100 === 1) {
        console.log("[stt-actor] Audio chunks received:", audioChunksReceived);
      }
      try {
        provider.sendAudio(event.audio);
      } catch (error) {
        if (!isAborted) {
          if (debug) console.error("[stt-actor] Error sending audio:", error);
          sendBack({
            type: "_stt:error",
            error: error instanceof Error ? error : new Error(String(error)),
            timestamp: Date.now(),
          });
        }
      }
    }
  });

  return () => {
    isAborted = true;
    abortSignal.removeEventListener("abort", handleAbort);
    if (debug) console.log("[stt-actor] Stopping STT provider");
    try {
      provider.stop();
    } catch (error) {
      if (debug) console.error("[stt-actor] Error stopping provider:", error);
    }
  };
});
