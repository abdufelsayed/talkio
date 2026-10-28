/**
 * Turn Detector Actor
 *
 * Runs the optional turn detector provider. It receives every transcript, the
 * agent's voice activity (from whichever source is active), the input audio,
 * and the conversation so far, and reports turn signals back to the machine.
 * Without a turn detector, the STT provider's final transcripts (or its own
 * turn signals) end the user's turn.
 *
 * @module agent/actors/turn-detector
 */

import { fromCallback } from "xstate";

import type { TurnSignals } from "../../providers/types";
import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { getConfigNow } from "../time";

type SendTurnSignal = (event: MachineEvent) => void;

/** Maps turn signal callbacks to machine events, dropping them once inactive. */
export function createTurnSignals(
  send: SendTurnSignal,
  isActive: () => boolean,
  now: () => number,
): TurnSignals {
  return {
    turnEnd: (transcript) => {
      if (isActive()) send({ type: "_turn:end", transcript, timestamp: now() });
    },
    turnAbandoned: (reason) => {
      if (isActive()) send({ type: "_turn:abandoned", reason, timestamp: now() });
    },
    eagerTurnEnd: (transcript) => {
      if (isActive()) send({ type: "_turn:eager-end", transcript, timestamp: now() });
    },
    turnResumed: () => {
      if (isActive()) send({ type: "_turn:resumed", timestamp: now() });
    },
    endOfTurnProbability: (probability) => {
      if (!isActive() || !Number.isFinite(probability)) return;
      send({
        type: "_turn:prediction",
        probability: Math.min(1, Math.max(0, probability)),
        timestamp: now(),
      });
    },
  };
}

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
      ...createTurnSignals(sendBack, isActive, now),
      audioFormat: config.audio.input,
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
      case "_audio:input":
        if (provider.onAudio) call("onAudio", () => provider.onAudio?.(event.audio));
        break;
      case "_context:messages":
        if (provider.onContext) call("onContext", () => provider.onContext?.(event.messages));
        break;
    }
  });

  return () => {
    stopped = true;
    call("stop", () => provider.stop());
  };
});
