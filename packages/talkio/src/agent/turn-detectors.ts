/**
 * Turns the `turnDetector` option (a function, a detector, or several) into a
 * single detector the agent runs.
 *
 * @module agent/turn-detectors
 */

import type {
  Pause,
  TurnDetector,
  TurnDetectorFunction,
  TurnDetectorInput,
} from "../providers/types";

function toDetector(input: TurnDetector | TurnDetectorFunction): TurnDetector {
  return typeof input === "function" ? { onPause: input } : input;
}

export function resolveTurnDetector(
  input: TurnDetectorInput | undefined,
): TurnDetector | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return toDetector(input as TurnDetector | TurnDetectorFunction);
  const detectors = (input as readonly (TurnDetector | TurnDetectorFunction)[]).map(toDetector);
  if (detectors.length <= 1) return detectors[0];
  return combineTurnDetectors(detectors);
}

/**
 * Runs several detectors as one. Each detector's latest probability is kept
 * until the user speaks again, and the highest counts. Other signals pass
 * through, and one detector failing does not stop the others.
 */
function combineTurnDetectors(detectors: readonly TurnDetector[]): TurnDetector {
  const latest = new Map<TurnDetector, number>();
  let report: ((probability: number) => void) | null = null;
  let reportError: ((error: Error) => void) | null = null;

  const record = (detector: TurnDetector, probability: number) => {
    if (!Number.isFinite(probability)) return;
    latest.set(detector, probability);
    report?.(Math.max(...latest.values()));
  };

  const settle = <T>(fn: () => T | Promise<T>, onResult: (result: T) => void) => {
    const fail = (error: unknown) =>
      reportError?.(error instanceof Error ? error : new Error(String(error)));
    try {
      const result = fn();
      if (result instanceof Promise) result.then(onResult, fail);
      else onResult(result);
    } catch (error) {
      fail(error);
    }
  };

  const each = (fn: (detector: TurnDetector) => void) => {
    let failure: unknown = null;
    for (const detector of detectors) {
      try {
        fn(detector);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
  };

  const combined: TurnDetector = {
    name: detectors.map((detector) => detector.name ?? "function").join(" + "),
    output: detectors.some((detector) => (detector.output ?? "probability") === "probability")
      ? "probability"
      : "decision",
    start(ctx) {
      report = (probability) => ctx.turn.probability(probability);
      reportError = (error) => ctx.error(error);
      for (const detector of detectors) {
        settle(
          () =>
            detector.start?.({
              ...ctx,
              turn: { ...ctx.turn, probability: (probability) => record(detector, probability) },
            }),
          () => {},
        );
      }
    },
    stop() {
      each((detector) => detector.stop?.());
    },
    onSpeechStart() {
      latest.clear();
      each((detector) => detector.onSpeechStart?.());
    },
    onPause(pause: Pause) {
      for (const detector of detectors) {
        settle(
          () => detector.onPause?.(pause),
          (probability) => {
            if (typeof probability === "number" && !pause.signal.aborted) {
              record(detector, probability);
            }
          },
        );
      }
    },
  };
  if (detectors.some((detector) => detector.sendAudio)) {
    combined.sendAudio = (audio) => each((detector) => detector.sendAudio?.(audio));
  }
  if (detectors.some((detector) => detector.onTranscript)) {
    combined.onTranscript = (text, isFinal) =>
      each((detector) => detector.onTranscript?.(text, isFinal));
  }
  return combined;
}
