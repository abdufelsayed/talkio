/**
 * Turn Detector Actor
 *
 * Runs the optional turn detector. It receives every transcript, the start of
 * the user's speech, the input audio, and each pause in the user's turn, and
 * reports turn signals back to the machine. Without a turn detector, the STT
 * provider's final transcripts (or its own turn signals) end the user's turn.
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
    end: (transcript = "") => {
      if (isActive()) send({ type: "_turn:end", transcript, timestamp: now() });
    },
    abandoned: (reason) => {
      if (isActive()) send({ type: "_turn:abandoned", reason, timestamp: now() });
    },
    eagerEnd: (transcript = "") => {
      if (isActive()) send({ type: "_turn:eager-end", transcript, timestamp: now() });
    },
    resumed: () => {
      if (isActive()) send({ type: "_turn:resumed", timestamp: now() });
    },
    probability: (probability) => {
      if (!isActive() || !Number.isFinite(probability)) return;
      send({
        type: "_turn:prediction",
        probability: Math.min(1, Math.max(0, probability)),
        timestamp: now(),
      });
    },
  };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export const turnDetectorActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    abortSignal: AbortSignal;
  }
>(({ sendBack, receive, input }) => {
  const { config, abortSignal } = input;
  const detector = config.turnDetector;
  const now = () => getConfigNow(config);
  let stopped = false;
  let pause: AbortController | null = null;

  if (!detector || abortSignal.aborted) return () => {};

  const isActive = () => !stopped && !abortSignal.aborted;
  const turn = createTurnSignals(sendBack, isActive, now);

  const reportError = (error: unknown) => {
    if (!isActive() || isAbortError(error)) return;
    sendBack({
      type: "_turn:error",
      error: error instanceof Error ? error : new Error(String(error)),
      timestamp: now(),
    });
  };

  const call = <T>(fn: () => T | Promise<T>, onResult?: (result: T) => void) => {
    try {
      const result = fn();
      if (isPromiseLike(result)) result.then(onResult, reportError);
      else onResult?.(result);
    } catch (error) {
      reportError(error);
    }
  };

  const endPause = () => {
    pause?.abort();
    pause = null;
  };

  call(() =>
    detector.start?.({
      audioFormat: config.audio.input,
      turn,
      error: reportError,
      signal: abortSignal,
    }),
  );

  receive((event) => {
    if (!isActive()) return;
    switch (event.type) {
      case "_stt:transcript":
        if (detector.onTranscript) call(() => detector.onTranscript?.(event.text, event.isFinal));
        break;
      case "_voice:start":
        endPause();
        if (detector.onSpeechStart) call(() => detector.onSpeechStart?.());
        break;
      case "_audio:input":
        if (detector.sendAudio) call(() => detector.sendAudio?.(event.audio));
        break;
      case "_pause:start": {
        endPause();
        if (!detector.onPause) break;
        const current = new AbortController();
        pause = current;
        const { transcript, messages } = event;
        call(
          () => detector.onPause?.({ transcript, messages, signal: current.signal }),
          (probability) => {
            if (typeof probability === "number" && !current.signal.aborted) {
              turn.probability(probability);
            }
          },
        );
        break;
      }
      case "_pause:end":
        endPause();
        break;
    }
  });

  return () => {
    stopped = true;
    endPause();
    call(() => detector.stop?.());
  };
});
