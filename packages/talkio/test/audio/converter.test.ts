import { describe, expect, it } from "vitest";

import { linear16ToMulaw } from "../../src/audio/conversions";
import { createSampleConverter } from "../../src/audio/converter";
import type { NormalizedAudioFormat } from "../../src/audio/types";

const format = (encoding: "linear16" | "mulaw" | "opus", sampleRate = 16000, channels = 1) =>
  ({ encoding, sampleRate, channels }) as NormalizedAudioFormat;

describe("sample converter", () => {
  it("keeps a sample split across chunks", () => {
    const convert = createSampleConverter(format("linear16"), 16000);
    const bytes = new Uint8Array(new Int16Array([16384, -16384]).buffer);
    expect(Array.from(convert(bytes.slice(0, 3).buffer))).toEqual([0.5]);
    expect(Array.from(convert(bytes.slice(3).buffer))).toEqual([-0.5]);
  });

  it("decodes mulaw and resamples 8 kHz to 16 kHz", () => {
    const convert = createSampleConverter(format("mulaw", 8000), 16000);
    const samples = convert(linear16ToMulaw(new Int16Array(80).fill(8000)).slice().buffer);
    expect(samples).toHaveLength(160);
    expect(samples[80]).toBeCloseTo(8000 / 32768, 1);
  });

  it("mixes stereo down to mono", () => {
    const convert = createSampleConverter(format("linear16", 16000, 2), 16000);
    expect(Array.from(convert(new Int16Array([16384, 0, 0, 16384]).buffer))).toEqual([0.25, 0.25]);
  });

  it("rejects compressed audio", () => {
    expect(() => createSampleConverter(format("opus"), 16000)).toThrow("not opus");
  });
});
