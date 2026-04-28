/**
 * Audio Decoder
 *
 * Decodes compressed audio formats (opus, webm) into raw PCM samples.
 * This module provides a unified interface for decoding various audio formats
 * that may be received from browsers (MediaRecorder) or other sources.
 *
 * @module audio/decoder
 */

import type { AudioEncoding } from "./types";

/**
 * Decoded audio result containing PCM samples and format information.
 */
export interface DecodedAudio {
  /** PCM samples as Int16Array (linear16 format) */
  samples: Int16Array;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Number of channels (1 = mono, 2 = stereo) */
  channels: number;
}

/**
 * Audio decoder interface for decoding compressed audio formats.
 */
export interface AudioDecoder {
  /**
   * Decode compressed audio data to PCM.
   *
   * @param data - Compressed audio data
   * @param encoding - The encoding format of the data
   * @returns Decoded PCM audio
   */
  decode(data: ArrayBuffer, encoding: AudioEncoding): Promise<DecodedAudio>;

  /**
   * Check if this decoder supports a given encoding.
   *
   * @param encoding - The encoding to check
   * @returns true if the encoding is supported
   */
  supports(encoding: AudioEncoding): boolean;

  /**
   * Clean up decoder resources.
   */
  dispose(): void;
}

/**
 * Encodings that are already raw PCM and don't need decoding.
 */
const RAW_PCM_ENCODINGS: AudioEncoding[] = ["linear16", "linear32", "float32", "mulaw", "alaw"];

/**
 * Check if an encoding is raw PCM (no decoding needed).
 */
export function isRawPCM(encoding: AudioEncoding): boolean {
  return RAW_PCM_ENCODINGS.includes(encoding);
}

/**
 * Check if an encoding requires decoding to PCM.
 */
export function requiresDecoding(encoding: AudioEncoding): boolean {
  return !isRawPCM(encoding);
}

/**
 * Internal opus decoder wrapper that provides a consistent interface.
 */
interface OpusDecoderWrapper {
  decode(data: Uint8Array): Int16Array;
  destroy(): void;
}

type OpusDecodeResult = {
  channelData: Float32Array[];
  samplesDecoded: number;
  errors?: unknown[];
};

type OpusDecoderInstance = {
  ready: Promise<void>;
  decodeFrame: (opusFrame: Uint8Array) => OpusDecodeResult;
  free: () => void;
};

type OpusDecoderConstructor = new (options: {
  sampleRate: number;
  channels: number;
}) => OpusDecoderInstance;

type OpusDecoderModule = {
  OpusDecoder: OpusDecoderConstructor;
};

const importOpusDecoder = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<OpusDecoderModule>;

/**
 * Convert Float32Array PCM to Int16Array PCM.
 */
function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16;
}

/**
 * Create an opus decoder wrapper using the WASM-based opus-decoder.
 * Works on all platforms without native compilation.
 */
async function createOpusDecoderWrapper(
  sampleRate: number,
  channels: number,
): Promise<OpusDecoderWrapper> {
  // opus-decoder only supports specific sample rates
  const validSampleRates = [8000, 12000, 16000, 24000, 48000] as const;
  const opusSampleRate = validSampleRates.includes(sampleRate as (typeof validSampleRates)[number])
    ? (sampleRate as (typeof validSampleRates)[number])
    : 48000;

  const { OpusDecoder } = await importOpusDecoder("opus-decoder");
  const decoder = new OpusDecoder({
    sampleRate: opusSampleRate,
    channels,
  });
  await decoder.ready;

  return {
    decode(data: Uint8Array): Int16Array {
      const result = decoder.decodeFrame(data);
      if (result.errors && result.errors.length > 0) {
        throw new Error(`Opus decode error: ${result.errors.join(", ")}`);
      }
      // Merge channels into interleaved Int16Array
      if (result.channelData.length === 1) {
        return float32ToInt16(result.channelData[0]);
      }
      // Interleave stereo/multichannel
      const samplesPerChannel = result.samplesDecoded;
      const int16 = new Int16Array(samplesPerChannel * channels);
      for (let i = 0; i < samplesPerChannel; i++) {
        for (let ch = 0; ch < channels; ch++) {
          const sample = Math.max(-1, Math.min(1, result.channelData[ch][i]));
          int16[i * channels + ch] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
      }
      return int16;
    },
    destroy(): void {
      decoder.free();
    },
  };
}

/**
 * WebM/Ogg container parser for extracting opus frames.
 * This is a minimal parser that extracts audio data from webm containers.
 */
function extractOpusFromWebM(data: ArrayBuffer): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = 0;
  const bytes = new Uint8Array(data);

  // WebM uses EBML format. This is a simplified parser that looks for
  // SimpleBlock elements containing opus frames.
  while (offset < bytes.length - 4) {
    // Look for SimpleBlock (0xa3) or Block (0xa1) elements
    if (bytes[offset] === 0xa3 || bytes[offset] === 0xa1) {
      offset++;

      // Read EBML variable-length size
      let size = 0;
      let sizeBytes = 0;
      const firstByte = bytes[offset];

      if ((firstByte & 0x80) !== 0) {
        size = firstByte & 0x7f;
        sizeBytes = 1;
      } else if ((firstByte & 0x40) !== 0) {
        if (offset + 2 > bytes.length) break;
        size = ((firstByte & 0x3f) << 8) | bytes[offset + 1];
        sizeBytes = 2;
      } else if ((firstByte & 0x20) !== 0) {
        if (offset + 3 > bytes.length) break;
        size = ((firstByte & 0x1f) << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
        sizeBytes = 3;
      } else {
        // Larger sizes - skip for now
        offset++;
        continue;
      }

      offset += sizeBytes;

      if (offset + size <= bytes.length && size > 4) {
        // Skip track number (1-3 bytes) and timestamp (2 bytes) and flags (1 byte)
        const headerSize = 4; // Minimum header size
        if (size > headerSize) {
          const frameData = bytes.slice(offset + headerSize, offset + size);
          if (frameData.length > 0) {
            frames.push(frameData);
          }
        }
      }

      offset += size;
    } else {
      offset++;
    }
  }

  return frames;
}

/**
 * Create an audio decoder instance.
 *
 * Uses WASM-based opus decoding that works on all platforms
 * without requiring native compilation.
 *
 * @param options - Decoder configuration
 * @returns AudioDecoder instance
 */
export async function createAudioDecoder(options?: {
  sampleRate?: number;
  channels?: number;
}): Promise<AudioDecoder> {
  const sampleRate = options?.sampleRate ?? 48000;
  const channels = options?.channels ?? 1;

  const opusDecoder = await createOpusDecoderWrapper(sampleRate, channels);

  return {
    supports(encoding: AudioEncoding): boolean {
      return (
        encoding === "opus" || encoding === "ogg-opus" || encoding === "webm" || encoding === "wav"
      );
    },

    async decode(data: ArrayBuffer, encoding: AudioEncoding): Promise<DecodedAudio> {
      // WAV decoding
      if (encoding === "wav") {
        return decodeWav(data);
      }

      // Opus decoding
      if (encoding === "opus") {
        const samples = opusDecoder.decode(new Uint8Array(data));
        return { samples, sampleRate, channels };
      }

      // WebM/Ogg-Opus decoding
      if (encoding === "webm" || encoding === "ogg-opus") {
        const frames = extractOpusFromWebM(data);
        if (frames.length === 0) {
          throw new Error("No opus frames found in container");
        }

        // Decode all frames and concatenate
        const decodedFrames: Int16Array[] = [];
        let skippedFrames = 0;
        for (const frame of frames) {
          try {
            const decoded = opusDecoder.decode(frame);
            decodedFrames.push(decoded);
          } catch {
            skippedFrames++;
          }
        }

        if (skippedFrames > 0) {
          console.warn(
            `[audio/decoder] Skipped ${skippedFrames} invalid opus frame(s) out of ${frames.length} total`,
          );
        }

        if (decodedFrames.length === 0) {
          throw new Error("Failed to decode any opus frames");
        }

        // Concatenate all decoded frames
        const totalLength = decodedFrames.reduce((sum, frame) => sum + frame.length, 0);
        const samples = new Int16Array(totalLength);
        let concatOffset = 0;
        for (const frame of decodedFrames) {
          samples.set(frame, concatOffset);
          concatOffset += frame.length;
        }

        return { samples, sampleRate, channels };
      }

      throw new Error(`Unsupported encoding: ${encoding}`);
    },

    dispose(): void {
      opusDecoder.destroy();
    },
  };
}

/**
 * Decode WAV file to PCM samples.
 * Supports standard PCM WAV files (8-bit, 16-bit, 32-bit).
 *
 * @param data - WAV file data
 * @returns Decoded audio
 */
function decodeWav(data: ArrayBuffer): DecodedAudio {
  const view = new DataView(data);

  // Verify RIFF header
  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (riff !== "RIFF") {
    throw new Error("Invalid WAV file: missing RIFF header");
  }

  // Verify WAVE format
  const wave = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11),
  );
  if (wave !== "WAVE") {
    throw new Error("Invalid WAV file: missing WAVE format");
  }

  // Find fmt chunk
  let offset = 12;
  let channels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset < view.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset === 0 || dataSize === 0) {
    throw new Error("Invalid WAV file: missing data chunk");
  }

  // Convert to Int16Array
  let samples: Int16Array;

  if (bitsPerSample === 16) {
    // Create aligned copy to avoid potential alignment issues
    const alignedBuffer = data.slice(dataOffset, dataOffset + dataSize);
    samples = new Int16Array(alignedBuffer);
  } else if (bitsPerSample === 8) {
    // Convert 8-bit unsigned to 16-bit signed
    const bytes = new Uint8Array(data, dataOffset, dataSize);
    samples = new Int16Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      samples[i] = (bytes[i] - 128) * 256;
    }
  } else if (bitsPerSample === 32) {
    // Assume 32-bit float - create aligned copy to avoid alignment issues
    const alignedBuffer = data.slice(dataOffset, dataOffset + dataSize);
    const floats = new Float32Array(alignedBuffer);
    samples = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      const sample = Math.max(-1, Math.min(1, floats[i]));
      samples[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
  } else {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
  }

  return { samples, sampleRate, channels };
}
