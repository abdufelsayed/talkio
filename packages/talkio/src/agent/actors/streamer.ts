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
import { trace } from "../trace";

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
  const clearedRequestIds = new Set<string>();

  const handleAbort = () => {
    isAborted = true;
    trace(config, { type: "audio:stream-end" });
    sendBack({ type: "_audio:output-end", timestamp: now() });
  };

  abortSignal.addEventListener("abort", handleAbort);

  sendBack({ type: "_audio:output-start", timestamp: now() });
  trace(config, { type: "audio:stream-start" });

  receive((event) => {
    if (isAborted) return;

    if (event.type === "_audio:output-chunk") {
      if (event.requestId && clearedRequestIds.has(event.requestId)) {
        droppedChunks++;
        trace(config, {
          type: "audio:drop",
          turnId: event.turnId,
          requestId: event.requestId,
          data: {
            bytes: event.audio.byteLength,
            droppedChunks,
            reason: "cleared-request",
          },
        });
        return;
      }

      if (audioStreamController) {
        try {
          const desiredSize = audioStreamController.desiredSize;
          if (desiredSize !== null && desiredSize <= 0) {
            droppedChunks++;
            trace(config, {
              type: "audio:drop",
              turnId: event.turnId,
              requestId: event.requestId,
              data: {
                bytes: event.audio.byteLength,
                desiredSize,
                droppedChunks,
                reason: "consumer-backpressure",
              },
            });
            if (debug && droppedChunks % 10 === 1) {
              console.warn("[audio-streamer] Dropped audio output chunks:", droppedChunks);
            }
            return;
          }
          audioStreamController.enqueue(event.audio);
          trace(config, {
            type: "audio:send",
            turnId: event.turnId,
            requestId: event.requestId,
            data: { bytes: event.audio.byteLength, desiredSize },
          });
        } catch {
          return;
        }
      }
      return;
    }

    if (event.type === "_audio:output-clear") {
      if (event.requestId) {
        clearedRequestIds.add(event.requestId);
      }
      trace(config, { type: "audio:clear", turnId: event.turnId, requestId: event.requestId });
    }
  });

  return () => {
    isAborted = true;
    abortSignal.removeEventListener("abort", handleAbort);
    if (debug && droppedChunks > 0) {
      console.warn("[audio-streamer] Total dropped audio output chunks:", droppedChunks);
    }
  };
});
