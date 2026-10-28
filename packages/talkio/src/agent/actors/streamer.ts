/**
 * Audio Streamer Actor
 *
 * Writes released AI audio into the agent's output buffer, and discards unread
 * audio of a turn when the machine clears it.
 *
 * @module agent/actors/streamer
 */

import { fromCallback } from "xstate";

import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import type { AudioOutputBuffer } from "../audio-output";
import { trace } from "../trace";

export interface AudioStreamerInput {
  config: NormalizedAgentConfig;
  output: AudioOutputBuffer;
}

export const audioStreamerActor = fromCallback<MachineEvent, AudioStreamerInput>(
  ({ receive, input }) => {
    const { config, output } = input;

    trace(config, { type: "audio:stream-start" });

    receive((event) => {
      if (event.type === "_audio:output-clear") {
        const removed = output.clear(event.turnId);
        trace(config, {
          type: "audio:clear",
          turnId: event.turnId,
          requestId: event.requestId,
          data: { removedChunks: removed },
        });
        return;
      }
      if (event.type !== "_audio:output-chunk") return;

      const dropped = output.push({
        audio: event.audio,
        turnId: event.turnId,
        requestId: event.requestId,
      });
      trace(config, {
        type: "audio:send",
        turnId: event.turnId,
        requestId: event.requestId,
        data: { bytes: event.audio.byteLength },
      });
      if (dropped > 0) {
        trace(config, {
          type: "audio:drop",
          turnId: event.turnId,
          requestId: event.requestId,
          data: { droppedChunks: dropped, reason: "output-buffer-full" },
        });
      }
    });

    return () => {
      trace(config, { type: "audio:stream-end" });
    };
  },
);
