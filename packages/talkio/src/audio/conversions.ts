/**
 * Audio Conversion Utilities
 *
 * Functions for converting between audio formats, sample rates, and channel counts.
 * These utilities handle the low-level audio transformations needed to normalize
 * audio from various sources (Web Audio API, MediaRecorder, telephony) into
 * formats expected by STT and VAD providers.
 *
 * @module audio/conversions
 */

/**
 * Convert Float32Array audio samples to Int16Array (linear16).
 *
 * Float32 samples are in the range [-1.0, 1.0].
 * Int16 samples are in the range [-32768, 32767].
 *
 * @param float32 - Float32Array audio samples
 * @returns Int16Array audio samples
 *
 * @example
 * ```typescript
 * const float32 = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
 * const int16 = float32ToInt16(float32);
 * // int16 = Int16Array([0, 16383, -16384, 32767, -32768])
 * ```
 */
export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    // Clamp to [-1, 1] range and scale to Int16 range
    const sample = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16;
}

/**
 * Convert Int16Array audio samples to Float32Array.
 *
 * Int16 samples are in the range [-32768, 32767].
 * Float32 samples are in the range [-1.0, 1.0].
 *
 * @param int16 - Int16Array audio samples
 * @returns Float32Array audio samples
 *
 * @example
 * ```typescript
 * const int16 = new Int16Array([0, 16383, -16384, 32767, -32768]);
 * const float32 = int16ToFloat32(int16);
 * // float32 ≈ Float32Array([0.0, 0.5, -0.5, 1.0, -1.0])
 * ```
 */
export function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x8000;
  }
  return float32;
}

/**
 * Convert linear16 (Int16) ArrayBuffer to Float32Array.
 *
 * @param buffer - ArrayBuffer containing Int16 PCM samples (little-endian)
 * @returns Float32Array audio samples
 */
export function linear16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const int16 = new Int16Array(buffer);
  return int16ToFloat32(int16);
}

/**
 * Convert Float32Array to linear16 ArrayBuffer.
 *
 * @param float32 - Float32Array audio samples
 * @returns ArrayBuffer containing Int16 PCM samples (little-endian)
 */
export function float32ToLinear16(float32: Float32Array): ArrayBuffer {
  const int16 = float32ToInt16(float32);
  // Create a new ArrayBuffer copy to ensure we return ArrayBuffer, not SharedArrayBuffer
  const buffer = new ArrayBuffer(int16.byteLength);
  new Int16Array(buffer).set(int16);
  return buffer;
}

/**
 * Convert stereo audio to mono by averaging left and right channels.
 *
 * @param samples - Audio samples (Float32Array or Int16Array) with interleaved stereo
 * @returns Mono audio samples of the same type
 *
 * @example
 * ```typescript
 * // Stereo: [L0, R0, L1, R1, L2, R2, ...]
 * const stereo = new Float32Array([0.5, 0.3, 0.7, 0.1, -0.2, -0.4]);
 * const mono = stereoToMono(stereo);
 * // mono = Float32Array([0.4, 0.4, -0.3]) // averages of each pair
 * ```
 */
export function stereoToMono<T extends Float32Array | Int16Array>(samples: T): T {
  const monoLength = Math.floor(samples.length / 2);
  const MonoArrayType = samples instanceof Float32Array ? Float32Array : Int16Array;
  const mono = new MonoArrayType(monoLength);

  for (let i = 0; i < monoLength; i++) {
    const left = samples[i * 2];
    const right = samples[i * 2 + 1];
    mono[i] = (left + right) / 2;
  }

  return mono as T;
}

/**
 * Resample audio from one sample rate to another using linear interpolation.
 *
 * This is a simple resampler suitable for voice audio. For higher quality
 * resampling, consider using a library with sinc interpolation.
 *
 * @param samples - Audio samples (Float32Array)
 * @param fromRate - Source sample rate in Hz
 * @param toRate - Target sample rate in Hz
 * @returns Resampled Float32Array audio samples
 *
 * @example
 * ```typescript
 * // Downsample from 48kHz to 16kHz
 * const audio48k = new Float32Array(4800); // 100ms at 48kHz
 * const audio16k = resample(audio48k, 48000, 16000);
 * // audio16k.length === 1600 (100ms at 16kHz)
 * ```
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) {
    throw new Error(
      `Invalid sample rates: fromRate=${fromRate}, toRate=${toRate}. Both must be positive.`,
    );
  }

  if (fromRate === toRate) {
    return samples;
  }

  const ratio = fromRate / toRate;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const fraction = srcIndex - srcIndexFloor;

    // Linear interpolation between adjacent samples
    output[i] = samples[srcIndexFloor] * (1 - fraction) + samples[srcIndexCeil] * fraction;
  }

  return output;
}

/**
 * Resample Int16 audio from one sample rate to another.
 *
 * Converts to Float32, resamples, then converts back to Int16.
 *
 * @param samples - Audio samples (Int16Array)
 * @param fromRate - Source sample rate in Hz
 * @param toRate - Target sample rate in Hz
 * @returns Resampled Int16Array audio samples
 */
export function resampleInt16(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) {
    return samples;
  }

  const float32 = int16ToFloat32(samples);
  const resampled = resample(float32, fromRate, toRate);
  return float32ToInt16(resampled);
}

/**
 * Convert mu-law encoded audio to linear16.
 *
 * Mu-law is a companding algorithm used in telephony (North America, Japan).
 * Each mu-law byte expands to a 16-bit linear sample.
 *
 * @param mulaw - Uint8Array of mu-law encoded samples
 * @returns Int16Array of linear PCM samples
 */
export function mulawToLinear16(mulaw: Uint8Array): Int16Array {
  const MULAW_BIAS = 33;
  const linear = new Int16Array(mulaw.length);

  for (let i = 0; i < mulaw.length; i++) {
    const mulawByte = ~mulaw[i] & 0xff;
    const sign = mulawByte & 0x80;
    const exponent = (mulawByte >> 4) & 0x07;
    const mantissa = mulawByte & 0x0f;

    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;

    linear[i] = sign ? -sample : sample;
  }

  return linear;
}

/**
 * Convert a-law encoded audio to linear16.
 *
 * A-law is a companding algorithm used in telephony (Europe, rest of world).
 * Each a-law byte expands to a 16-bit linear sample.
 *
 * @param alaw - Uint8Array of a-law encoded samples
 * @returns Int16Array of linear PCM samples
 */
export function alawToLinear16(alaw: Uint8Array): Int16Array {
  const linear = new Int16Array(alaw.length);

  for (let i = 0; i < alaw.length; i++) {
    const alawByte = alaw[i] ^ 0x55;
    const sign = alawByte & 0x80;
    const exponent = (alawByte >> 4) & 0x07;
    const mantissa = alawByte & 0x0f;

    let sample: number;
    if (exponent === 0) {
      sample = (mantissa << 4) + 8;
    } else {
      sample = ((mantissa << 4) + 0x108) << (exponent - 1);
    }

    linear[i] = sign ? sample : -sample;
  }

  return linear;
}

/**
 * Convert linear16 to mu-law encoding.
 *
 * @param linear - Int16Array of linear PCM samples
 * @returns Uint8Array of mu-law encoded samples
 */
export function linear16ToMulaw(linear: Int16Array): Uint8Array {
  const MULAW_BIAS = 33;
  const MULAW_MAX = 0x1fff;
  const mulaw = new Uint8Array(linear.length);

  for (let i = 0; i < linear.length; i++) {
    let sample = linear[i];
    const sign = sample < 0 ? 0x80 : 0;

    if (sign) sample = sample === -32768 ? 32767 : -sample;
    sample = Math.min(sample + MULAW_BIAS, MULAW_MAX);

    let exponent = 7;
    for (let expMask = 0x1000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);

    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }

  return mulaw;
}

/**
 * Convert linear16 to a-law encoding.
 *
 * @param linear - Int16Array of linear PCM samples
 * @returns Uint8Array of a-law encoded samples
 */
export function linear16ToAlaw(linear: Int16Array): Uint8Array {
  const alaw = new Uint8Array(linear.length);

  for (let i = 0; i < linear.length; i++) {
    let sample = linear[i];
    const sign = sample < 0 ? 0 : 0x80;

    if (sample < 0) sample = sample === -32768 ? 32767 : -sample;

    let exponent: number;
    let mantissa: number;

    if (sample < 256) {
      exponent = 0;
      mantissa = sample >> 4;
    } else {
      exponent = 1;
      while (sample >= 512 && exponent < 7) {
        sample >>= 1;
        exponent++;
      }
      mantissa = (sample >> 4) & 0x0f;
    }

    alaw[i] = (sign | (exponent << 4) | mantissa) ^ 0x55;
  }

  return alaw;
}
