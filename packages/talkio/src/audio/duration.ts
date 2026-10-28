import type { NormalizedAudioFormat } from "./types";

/**
 * Bytes per sample frame (one sample for every channel), or `null` for
 * compressed and container encodings whose size does not map to duration.
 */
export function bytesPerFrame(format: NormalizedAudioFormat): number | null {
  switch (format.encoding) {
    case "linear16":
      return 2 * format.channels;
    case "linear32":
    case "float32":
      return 4 * format.channels;
    case "mulaw":
    case "alaw":
      return format.channels;
    default:
      return null;
  }
}

export function audioSampleCount(bytes: number, format: NormalizedAudioFormat): number | null {
  const frameBytes = bytesPerFrame(format);
  return frameBytes === null ? null : Math.floor(bytes / frameBytes);
}

export function audioDurationMs(bytes: number, format: NormalizedAudioFormat): number | null {
  const samples = audioSampleCount(bytes, format);
  return samples === null ? null : (samples / format.sampleRate) * 1000;
}
