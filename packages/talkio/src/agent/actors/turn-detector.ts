/**
 * Turn Detector Actor
 *
 * Runs the optional turn detector provider. It receives every transcript and
 * the agent's voice activity (from whichever source is active) and reports
 * turn boundaries back to the machine. Without a turn detector, the STT
 * provider's final transcripts end the user's turn.
 *
 * @module agent/actors/turn-detector
 */

import { fromCallback } from "xstate";

import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { getConfigNow } from "../time";

export const turnDetectorActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    abortSignal: AbortSignal;
  }
>(({ sendBack, receive, input }) => {
  const { config, abortSignal } = input;
  const provider = config.turnDetector;
  const debug = config.debug ?? false;
  const now = () => getConfigNow(config);
  let stopped = false;

  if (!provider || abortSignal.aborted) return () => {};

  const isActive = () => !stopped && !abortSignal.aborted;

  const call = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      if (debug) console.error(`[turn-detector-actor] Error in ${label}:`, error);
    }
  };

  call("start", () =>
    provider.start({
      turnEnd: (transcript) => {
        if (!isActive()) return;
        sendBack({ type: "_turn:end", transcript, timestamp: now() });
      },
      turnAbandoned: (reason) => {
        if (!isActive()) return;
        sendBack({ type: "_turn:abandoned", reason, timestamp: now() });
      },
      signal: abortSignal,
    }),
  );

  receive((event) => {
    if (!isActive()) return;
    switch (event.type) {
      case "_stt:transcript":
        call("onTranscript", () => provider.onTranscript(event.text, event.isFinal));
        break;
      case "_voice:start":
        call("onSpeechStart", () => provider.onSpeechStart?.());
        break;
      case "_voice:end":
        call("onSpeechEnd", () => provider.onSpeechEnd(event.durationMs));
        break;
    }
  });

  return () => {
    stopped = true;
    call("stop", () => provider.stop());
  };
});
