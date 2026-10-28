/**
 * Audio Module
 *
 * Public API for audio format types, conversion utilities, and preprocessing.
 *
 * This module provides comprehensive audio handling capabilities:
 * - **Types**: `AudioFormat`, `AudioEncoding`, `AudioConfig`, etc.
 * - **Conversions**: `float32ToLinear16`, `resample`, `stereoToMono`, etc.
 * - **Decoding**: `createAudioDecoder` for opus/webm decoding
 * - **Preprocessing**: `createAudioPreprocessor` for normalizing any audio input
 *
 * @module audio
 */

// Types
export type {
  AudioConfig,
  AudioEncoding,
  AudioFormat,
  Channels,
  CompressedEncoding,
  ContainerEncoding,
  NormalizedAudioConfig,
  NormalizedAudioFormat,
  PCMEncoding,
  SampleRate,
  TelephonyEncoding,
} from "./types";

export {
  DEFAULT_AUDIO_CONFIG,
  DEFAULT_AUDIO_FORMAT,
  normalizeAudioConfig,
  normalizeFormat,
} from "./types";

// Conversions
export {
  float32ToInt16,
  int16ToFloat32,
  linear16ToFloat32,
  float32ToLinear16,
  stereoToMono,
  resample,
  resampleInt16,
  mulawToLinear16,
  alawToLinear16,
  linear16ToMulaw,
  linear16ToAlaw,
} from "./conversions";

export { createSampleConverter } from "./converter";

// Decoder
export type { DecodedAudio, AudioDecoder } from "./decoder";
export { createAudioDecoder, requiresDecoding, isRawPCM } from "./decoder";

// Preprocessor
export type {
  AudioInput,
  AudioInputConfig,
  AudioPreprocessor,
  AudioPreprocessorOptions,
} from "./preprocessor";
export { createAudioPreprocessor, isTypedArray, inferEncodingFromTypedArray } from "./preprocessor";
