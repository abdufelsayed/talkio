export interface SegmenterOptions {
  /** Probability at which a frame counts as speech. */
  threshold: number;
  /** Speech shorter than this is ignored (clicks, taps). */
  minSpeechMs: number;
  /** Silence that ends speech. */
  minSilenceMs: number;
  frameMs: number;
}

export type SegmentEvent = { type: "start" } | { type: "end"; durationMs: number };

/**
 * Turns per-frame speech probabilities into speech starts and ends, with the
 * hysteresis Silero recommends: speech starts at `threshold` and only a
 * probability 0.15 below it counts as silence, so speech that wavers around
 * the threshold does not flicker.
 */
export function createSegmenter(options: SegmenterOptions) {
  const silenceThreshold = Math.max(0.01, options.threshold - 0.15);
  const minSpeechFrames = Math.max(1, Math.ceil(options.minSpeechMs / options.frameMs));
  const minSilenceFrames = Math.max(1, Math.ceil(options.minSilenceMs / options.frameMs));
  let frame = 0;
  let speaking = false;
  let speechRun = 0;
  let startFrame = 0;
  let lastSpeechFrame = 0;
  let silenceRun = 0;

  return {
    push(probability: number): SegmentEvent | null {
      const current = frame++;
      if (!speaking) {
        speechRun = probability >= options.threshold ? speechRun + 1 : 0;
        if (speechRun < minSpeechFrames) return null;
        speaking = true;
        startFrame = current - speechRun + 1;
        lastSpeechFrame = current;
        silenceRun = 0;
        return { type: "start" };
      }
      if (probability >= options.threshold) {
        lastSpeechFrame = current;
        silenceRun = 0;
        return null;
      }
      if (probability >= silenceThreshold) return null;
      silenceRun++;
      if (silenceRun < minSilenceFrames) return null;
      speaking = false;
      speechRun = 0;
      return { type: "end", durationMs: (lastSpeechFrame - startFrame + 1) * options.frameMs };
    },
  };
}
