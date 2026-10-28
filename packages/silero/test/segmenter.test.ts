import { describe, expect, it } from "vitest";

import { createSegmenter } from "../src/segmenter";

function run(probabilities: number[]) {
  const segmenter = createSegmenter({
    threshold: 0.5,
    minSpeechMs: 64,
    minSilenceMs: 96,
    frameMs: 32,
  });
  return probabilities.flatMap((probability, frame) => {
    const event = segmenter.push(probability);
    return event ? [{ frame, ...event }] : [];
  });
}

describe("speech segmenter", () => {
  it("starts after the minimum speech and ends after the minimum silence", () => {
    expect(run([0.1, 0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1])).toEqual([
      { frame: 2, type: "start" },
      { frame: 7, type: "end", durationMs: 128 },
    ]);
  });

  it("ignores a click shorter than the minimum speech", () => {
    expect(run([0.9, 0.1, 0.9, 0.1, 0.1])).toEqual([]);
  });

  it("keeps speaking through probabilities that waver just below the threshold", () => {
    expect(run([0.9, 0.9, 0.4, 0.4, 0.4, 0.4, 0.9, 0.1, 0.1, 0.1])).toEqual([
      { frame: 1, type: "start" },
      { frame: 9, type: "end", durationMs: 224 },
    ]);
  });

  it("starts the silence over when speech returns", () => {
    expect(run([0.9, 0.9, 0.1, 0.1, 0.9, 0.1, 0.1, 0.1])).toEqual([
      { frame: 1, type: "start" },
      { frame: 7, type: "end", durationMs: 160 },
    ]);
  });
});
