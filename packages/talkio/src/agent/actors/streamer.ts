/**
 * Audio Streamer Actor
 *
 * XState callback actor that handles audio output streaming to the agent's audio stream.
 * This actor is responsible for:
 * - Receiving audio chunk events from the TTS provider
 * - Enqueuing audio chunks to the ReadableStream controller
 * - Managing the audio stream lifecycle (start/end events)
 * - Handling abort signals to gracefully close the stream
 * - Monitoring backpressure to prevent memory issues
 * - Ignoring chunks if the stream is already closed
 *
 * The actor acts as a bridge between the agent's internal audio events and
 * the public ReadableStream API, allowing consumers to read audio chunks
 * as they're produced by the TTS provider.
 *
 * @module agent/actors/streamer
 */

import { fromCallback } from "xstate";

import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { getConfigNow } from "../time";

export const audioStreamerActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    audioStreamController: ReadableStreamDefaultController<ArrayBuffer> | null;
    abortSignal: AbortSignal;
    debug?: boolean;
  }
>(({ sendBack, receive, input }) => {
  const { config, audioStreamController, abortSignal, debug } = input;
  const now = () => getConfigNow(config);

  let isAborted = false;
  let droppedChunks = 0;

  const handleAbort = () => {
    isAborted = true;
    sendBack({ type: "_audio:output-end", timestamp: now() });
  };

  abortSignal.addEventListener("abort", handleAbort);

  sendBack({ type: "_audio:output-start", timestamp: now() });

  receive((event) => {
    if (isAborted) return;

    if (event.type === "_audio:output-chunk") {
      if (audioStreamController) {
        try {
          // Check for backpressure
          const desiredSize = audioStreamController.desiredSize;
          if (desiredSize !== null && desiredSize <= 0) {
            droppedChunks++;
            if (debug && droppedChunks % 10 === 1) {
              console.warn(
                "[audio-streamer] Backpressure detected, consumer is slow. Dropped chunks:",
                droppedChunks,
              );
            }
            return;
          }
          audioStreamController.enqueue(event.audio);
        } catch {
          // Stream is closed, ignore silently
        }
      }
    }
  });

  return () => {
    isAborted = true;
    abortSignal.removeEventListener("abort", handleAbort);
    if (debug && droppedChunks > 0) {
      console.warn("[audio-streamer] Total dropped chunks due to backpressure:", droppedChunks);
    }
  };
});
