import { describe, expect, it } from "vitest";

import {
  alawToLinear16,
  linear16ToAlaw,
  linear16ToMulaw,
  mulawToLinear16,
} from "../../src/audio/conversions";

const decodeMulaw = (byte: number) => mulawToLinear16(new Uint8Array([byte]))[0];
const encodeMulaw = (sample: number) => linear16ToMulaw(new Int16Array([sample]))[0];
const decodeAlaw = (byte: number) => alawToLinear16(new Uint8Array([byte]))[0];
const encodeAlaw = (sample: number) => linear16ToAlaw(new Int16Array([sample]))[0];

const samples = [-32768, -20000, -8000, -1000, -100, 0, 100, 1000, 8000, 20000, 32767];

describe("G.711 mu-law", () => {
  it("matches the reference codec", () => {
    expect([0, 8000, 32767, -32768].map(encodeMulaw)).toEqual([0xff, 0xa0, 0x80, 0x00]);
    expect([0xff, 0x7f, 0xa0, 0x80, 0x00].map(decodeMulaw)).toEqual([0, 0, 7932, 32124, -32124]);
  });

  it("round-trips within the step size of each segment", () => {
    for (const sample of samples) {
      const decoded = decodeMulaw(encodeMulaw(sample)) ?? 0;
      expect(Math.abs(decoded - sample)).toBeLessThanOrEqual(Math.max(8, Math.abs(sample) * 0.04));
    }
  });

  it("keeps louder samples louder", () => {
    const decoded = samples.map((sample) => decodeMulaw(encodeMulaw(sample)) ?? 0);
    expect(decoded.every((value, index) => index === 0 || value > (decoded[index - 1] ?? 0))).toBe(
      true,
    );
  });
});

describe("G.711 A-law", () => {
  it("matches the reference codec", () => {
    expect([0, 32767, -32768].map(encodeAlaw)).toEqual([0xd5, 0xaa, 0x2a]);
    expect([0xd5, 0x55, 0xaa, 0x2a].map(decodeAlaw)).toEqual([8, -8, 32256, -32256]);
  });

  it("round-trips within the step size of each segment", () => {
    for (const sample of samples) {
      const decoded = decodeAlaw(encodeAlaw(sample)) ?? 0;
      expect(Math.abs(decoded - sample)).toBeLessThanOrEqual(Math.max(16, Math.abs(sample) * 0.04));
    }
  });
});
