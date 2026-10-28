import {
  alawToLinear16,
  int16ToFloat32,
  mulawToLinear16,
  resample,
  stereoToMono,
} from "./conversions";
import type { NormalizedAudioFormat } from "./types";

const BYTES_PER_SAMPLE: Partial<Record<NormalizedAudioFormat["encoding"], number>> = {
  linear16: 2,
  float32: 4,
  mulaw: 1,
  alaw: 1,
};

/**
 * Converts a stream of audio chunks into mono float samples at `sampleRate`,
 * for models that read raw samples (VAD, turn detection). A chunk can end
 * mid-sample, so the remainder is kept for the next one. Throws for encodings
 * it cannot decode, such as compressed audio.
 */
export function createSampleConverter(
  format: NormalizedAudioFormat,
  sampleRate: number,
): (chunk: ArrayBuffer) => Float32Array {
  const bytesPerSample = BYTES_PER_SAMPLE[format.encoding];
  if (bytesPerSample === undefined) {
    throw new Error(`Expected linear16, float32, mulaw or alaw audio, not ${format.encoding}`);
  }
  if (format.channels > 2) {
    throw new Error(`Expected mono or stereo audio, not ${format.channels} channels`);
  }
  const frameBytes = bytesPerSample * format.channels;
  let remainder = new Uint8Array(0);

  const decode = (bytes: Uint8Array): Float32Array => {
    switch (format.encoding) {
      case "linear16":
        return int16ToFloat32(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2));
      case "float32":
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
      case "mulaw":
        return int16ToFloat32(mulawToLinear16(bytes));
      default:
        return int16ToFloat32(alawToLinear16(bytes));
    }
  };

  return (chunk: ArrayBuffer): Float32Array => {
    const joined = new Uint8Array(remainder.length + chunk.byteLength);
    joined.set(remainder);
    joined.set(new Uint8Array(chunk), remainder.length);
    const usable = joined.length - (joined.length % frameBytes);
    remainder = joined.slice(usable);
    if (usable === 0) return new Float32Array(0);
    let samples = decode(joined.slice(0, usable));
    if (format.channels === 2) samples = stereoToMono(samples);
    return format.sampleRate === sampleRate
      ? samples
      : resample(samples, format.sampleRate, sampleRate);
  };
}
