/**
 * Deepgram Types
 *
 * Type definitions for Deepgram STT and TTS providers.
 *
 * This module defines all the types needed to work with Deepgram providers:
 * - Audio encoding types (STT and TTS)
 * - Provider settings and options interfaces
 * - WebSocket message types for STT and TTS
 * - Provider instance interface
 *
 * These types ensure type safety when configuring Deepgram providers and
 * enable compile-time validation of audio formats and API options.
 *
 * @module deepgram/types
 */

import type { STTProvider, TTSProvider } from "talkio";

import type { DeepgramSTTInputFormat } from "./deepgram-stt";
import type { DeepgramTTSOutputFormat } from "./deepgram-tts";

/**
 * Supported audio encodings for Deepgram STT streaming WebSocket.
 *
 * **PCM encodings:**
 * - `linear16` - 16-bit signed little-endian PCM (default, recommended)
 * - `linear32` - 32-bit signed little-endian PCM
 *
 * **Compressed encodings:**
 * - `flac` - Free Lossless Audio Codec
 * - `opus` - Opus codec (modern, low latency)
 * - `ogg-opus` - Opus in Ogg container
 * - `speex` - Speex speech codec
 *
 * **Adaptive multi-rate:**
 * - `amr-nb` - Adaptive multi-rate narrow band
 * - `amr-wb` - Adaptive multi-rate wide band
 *
 * **Telephony encodings (G.711):**
 * - `mulaw` - Mu-law encoding
 * - `alaw` - A-law encoding
 *
 * **Other:**
 * - `g729` - G.729 codec (telephony)
 *
 * @default "linear16"
 * @see https://developers.deepgram.com/docs/encoding
 */
export type DeepgramSTTEncoding =
  | "linear16"
  | "linear32"
  | "flac"
  | "mulaw"
  | "alaw"
  | "amr-nb"
  | "amr-wb"
  | "opus"
  | "ogg-opus"
  | "speex"
  | "g729";

/**
 * Supported audio encodings for Deepgram TTS streaming WebSocket.
 *
 * - `linear16` - 16-bit signed little-endian PCM (default). Supported sample rates: 8000, 16000, 24000, 32000, 48000 Hz
 * - `mulaw` - Mu-law encoding (telephony). Supported sample rates: 8000, 16000 Hz
 * - `alaw` - A-law encoding (telephony). Supported sample rates: 8000, 16000 Hz
 *
 * @default "linear16"
 * @see https://developers.deepgram.com/docs/tts-media-output-settings
 */
export type DeepgramTTSEncoding = "linear16" | "mulaw" | "alaw";

/**
 * Supported sample rates for Deepgram TTS linear16 encoding.
 * @default 24000
 */
export type DeepgramTTSLinear16SampleRate = 8000 | 16000 | 24000 | 32000 | 48000;

/**
 * Supported sample rates for Deepgram TTS mulaw/alaw encoding.
 * @default 8000
 */
export type DeepgramTTSTelephonySampleRate = 8000 | 16000;

/**
 * Settings for creating a Deepgram provider instance.
 *
 * These settings are shared across all STT and TTS providers created from
 * the same Deepgram provider instance. Individual providers can override
 * these settings.
 */
export interface DeepgramProviderSettings {
  /**
   * Deepgram API key.
   *
   * Falls back to `DEEPGRAM_API_KEY` environment variable if not provided.
   * Can also be set per-provider in `DeepgramSTTOptions` or `DeepgramTTSOptions`.
   */
  apiKey?: string;

  /**
   * Custom base URL for the Deepgram API.
   *
   * Useful for enterprise deployments, proxies, or custom endpoints.
   * Falls back to `api.deepgram.com` if not provided.
   *
   * @default "api.deepgram.com"
   */
  baseUrl?: string;
}

/**
 * Deepgram provider instance with STT and TTS factory methods.
 *
 * The returned providers are strongly typed with their supported audio formats,
 * enabling compile-time validation when configuring audio in createAgent.
 *
 * Created via {@link createDeepgram}.
 */
export interface DeepgramProvider {
  /**
   * Create a Speech-to-Text provider for streaming transcription.
   *
   * Returns a typed provider that connects to Deepgram's streaming WebSocket API
   * for real-time speech transcription. The provider only accepts Deepgram-supported
   * input formats, enabling compile-time validation.
   *
   * **Supported audio encodings:**
   * - `linear16` - 16-bit PCM (default, recommended)
   * - `linear32` - 32-bit PCM
   * - `mulaw` - Mu-law (telephony)
   * - `alaw` - A-law (telephony)
   * - `opus` - Opus codec
   * - `ogg-opus` - Opus in Ogg container
   *
   * @param options - STT configuration options
   * @param options.model - **Required.** STT model (e.g., "nova-3", "nova-2", "base")
   * @param options.language - Language code for transcription (default: "en")
   * @param options.interimResults - Include partial transcripts (default: true)
   * @param options.punctuate - Add punctuation to transcripts (default: true)
   * @param options.smartFormat - Apply smart formatting (default: true)
   * @param options.endpointing - Silence detection threshold in ms, or false to disable (default: 300)
   * @param options.utteranceEndMs - Fallback utterance end gap in ms (default: 1000)
   * @param options.keywords - Words to boost recognition for (domain-specific terms)
   * @param options.vad - Enable VAD events (default: true)
   * @param options.apiKey - API key (falls back to provider settings or DEEPGRAM_API_KEY env var)
   * @param options.baseUrl - Custom base URL (falls back to provider settings)
   * @returns A typed STT provider that can be used in createAgent
   *
   * @example Basic usage
   * ```typescript
   * const stt = deepgram.stt({
   *   model: "nova-3",
   *   language: "en",
   * });
   * ```
   *
   * @example With advanced options
   * ```typescript
   * const stt = deepgram.stt({
   *   model: "nova-2",
   *   language: "en",
   *   interimResults: true,
   *   punctuate: true,
   *   smartFormat: true,
   *   keywords: ["voice-ai", "Deepgram"],
   *   vad: true,
   * });
   * ```
   */
  stt: (options: DeepgramSTTOptions) => STTProvider<DeepgramSTTInputFormat>;

  /**
   * Create a Text-to-Speech provider for streaming synthesis.
   *
   * Returns a typed provider that connects to Deepgram's streaming WebSocket API
   * for real-time speech synthesis. The provider only accepts Deepgram-supported
   * output formats, enabling compile-time validation.
   *
   * **Supported audio encodings:**
   * - `linear16` - 16-bit PCM (default, recommended)
   *   - Sample rates: 8000, 16000, 24000 (default), 32000, 48000 Hz
   * - `mulaw` - Mu-law (telephony)
   *   - Sample rates: 8000 (default), 16000 Hz
   * - `alaw` - A-law (telephony)
   *   - Sample rates: 8000 (default), 16000 Hz
   *
   * @param options - TTS configuration options
   * @param options.model - **Required.** TTS model/voice (e.g., "aura-2-thalia-en")
   * @param options.encoding - Audio encoding (default: "linear16")
   * @param options.sampleRate - Sample rate in Hz (default: 24000 for linear16, 8000 for mulaw/alaw)
   * @param options.apiKey - API key (falls back to provider settings or DEEPGRAM_API_KEY env var)
   * @param options.baseUrl - Custom base URL (falls back to provider settings)
   * @returns A typed TTS provider that can be used in createAgent
   *
   * @example Basic usage
   * ```typescript
   * const tts = deepgram.tts({
   *   model: "aura-2-thalia-en",
   * });
   * ```
   *
   * @example With custom encoding and sample rate
   * ```typescript
   * const tts = deepgram.tts({
   *   model: "aura-2-thalia-en",
   *   encoding: "linear16",
   *   sampleRate: 48000, // High quality
   * });
   * ```
   *
   * @example Telephony format
   * ```typescript
   * const tts = deepgram.tts({
   *   model: "aura-2-thalia-en",
   *   encoding: "mulaw",
   *   sampleRate: 8000, // Telephony standard
   * });
   * ```
   */
  tts: (options: DeepgramTTSOptions) => TTSProvider<DeepgramTTSOutputFormat>;
}

/**
 * Options for creating a Deepgram STT provider.
 *
 * These options configure the Deepgram streaming STT WebSocket connection
 * and transcription behavior.
 */
export interface DeepgramSTTOptions {
  /**
   * Deepgram API key.
   *
   * Resolution order:
   * 1. This option value
   * 2. Provider settings (if using `createDeepgram()`)
   * 3. `DEEPGRAM_API_KEY` environment variable
   */
  apiKey?: string;

  /**
   * Custom base URL for the Deepgram API.
   *
   * Falls back to provider settings if not provided.
   * Useful for enterprise deployments or proxies.
   */
  baseUrl?: string;

  /**
   * STT model to use.
   *
   * Popular models:
   * - `"nova-3"` - Latest, highest accuracy
   * - `"nova-2"` - Previous generation
   * - `"base"` - Faster, lower cost
   *
   * @see https://developers.deepgram.com/docs/models
   */
  model: string;

  /**
   * Language code for transcription.
   *
   * Use ISO 639-1 language codes (e.g., "en", "es", "fr", "de").
   * Set to `null` for automatic language detection.
   *
   * @default "en"
   * @see https://developers.deepgram.com/docs/languages
   */
  language?: string;

  /**
   * Whether to include interim (partial) results.
   *
   * When `true`, the provider emits `human-turn:transcript` events
   * with `isFinal: false` for partial transcripts as the user speaks.
   * This enables real-time transcript display in the UI.
   *
   * @default true
   */
  interimResults?: boolean;

  /**
   * Whether to add punctuation to transcripts.
   *
   * When `true`, Deepgram automatically adds punctuation marks
   * (periods, commas, question marks, etc.) to transcripts.
   *
   * @default true
   */
  punctuate?: boolean;

  /**
   * Whether to apply smart formatting to transcripts.
   *
   * When `true`, Deepgram formats numbers, dates, times, and other
   * entities in a more readable way (e.g., "twenty three" → "23").
   *
   * @default true
   */
  smartFormat?: boolean;

  /**
   * Silence detection threshold in milliseconds.
   *
   * After this duration of silence, Deepgram marks the utterance complete
   * (`speech_final`) and the provider reports one final transcript for it.
   * Without a turn detector, this is what ends the user's turn, so values
   * below ~250ms cut speakers off at natural mid-sentence pauses. Set to
   * `false` to disable endpointing and rely on `utteranceEndMs` only.
   *
   * @default 300
   */
  endpointing?: number | false;

  /**
   * Gap in milliseconds between the last finalized word and Deepgram's
   * `UtteranceEnd` event. This is the fallback end-of-speech signal when
   * background noise keeps endpointing from firing. Requires `interimResults`.
   *
   * Deepgram sends interim results about once per second, so values below
   * 1000ms do not make the event arrive sooner.
   *
   * @default 1000
   */
  utteranceEndMs?: number;

  /**
   * Words to boost recognition for.
   *
   * Useful for domain-specific terminology, brand names, or technical terms
   * that might be misrecognized. Deepgram will prioritize these words during
   * transcription.
   *
   * @example
   * ```typescript
   * keywords: ["voice-ai", "Deepgram", "API"]
   * ```
   */
  keywords?: string[];

  /**
   * Enable Voice Activity Detection events.
   *
   * When `true`, Deepgram emits VAD events (`speechStart`, `speechEnd`)
   * that can be used for interruption detection and turn management.
   * If you have a dedicated VAD provider, you can set this to `false`.
   *
   * @default true
   */
  vad?: boolean;

  /**
   * Enable debug logging.
   *
   * When `true`, logs WebSocket connection status, messages received,
   * and audio chunk counts to the console.
   *
   * @default false
   */
  debug?: boolean;
}

/**
 * Options for creating a Deepgram TTS provider.
 *
 * These options configure the Deepgram streaming TTS WebSocket connection
 * and audio output format.
 */
export interface DeepgramTTSOptions {
  /**
   * Deepgram API key.
   *
   * Resolution order:
   * 1. This option value
   * 2. Provider settings (if using `createDeepgram()`)
   * 3. `DEEPGRAM_API_KEY` environment variable
   */
  apiKey?: string;

  /**
   * Custom base URL for the Deepgram API.
   *
   * Falls back to provider settings if not provided.
   * Useful for enterprise deployments or proxies.
   */
  baseUrl?: string;

  /**
   * TTS model/voice to use.
   *
   * Format: `"aura-2-{voice}-{language}"`
   *
   * Popular voices:
   * - `"aura-2-thalia-en"` - Female, English
   * - `"aura-2-athena-en"` - Female, English
   * - `"aura-2-hera-en"` - Female, English
   * - `"aura-2-zeus-en"` - Male, English
   *
   * @see https://developers.deepgram.com/docs/tts-models
   */
  model: string;

  /**
   * Audio encoding for the output audio.
   *
   * - `linear16` - 16-bit signed little-endian PCM (default, recommended)
   *   - Supported sample rates: 8000, 16000, 24000, 32000, 48000 Hz
   *   - Best quality, suitable for most applications
   * - `mulaw` - Mu-law encoding (telephony, G.711)
   *   - Supported sample rates: 8000, 16000 Hz
   *   - Lower bandwidth, suitable for telephony
   * - `alaw` - A-law encoding (telephony, G.711)
   *   - Supported sample rates: 8000, 16000 Hz
   *   - Lower bandwidth, suitable for telephony
   *
   * @default "linear16"
   * @see https://developers.deepgram.com/docs/tts-media-output-settings
   */
  encoding?: DeepgramTTSEncoding;

  /**
   * Sample rate for the output audio in Hz.
   *
   * Higher sample rates provide better audio quality but require more bandwidth.
   * Supported sample rates vary by encoding:
   *
   * - `linear16`: 8000, 16000, 24000 (default), 32000, 48000 Hz
   *   - 24000 Hz is recommended for high-quality voice
   *   - 48000 Hz for professional audio
   * - `mulaw`: 8000 (default), 16000 Hz
   *   - 8000 Hz is the telephony standard
   * - `alaw`: 8000 (default), 16000 Hz
   *   - 8000 Hz is the telephony standard
   *
   * @default 24000 for linear16, 8000 for mulaw/alaw
   * @see https://developers.deepgram.com/docs/tts-media-output-settings
   */
  sampleRate?: DeepgramTTSLinear16SampleRate | DeepgramTTSTelephonySampleRate;
}

/**
 * Deepgram WebSocket message types for STT.
 */
export interface DeepgramSTTTranscript {
  type: "Results";
  channel_index: [number, number];
  duration: number;
  start: number;
  is_final: boolean;
  speech_final: boolean;
  channel: {
    alternatives: Array<{
      transcript: string;
      confidence: number;
      words: Array<{
        word: string;
        start: number;
        end: number;
        confidence: number;
      }>;
    }>;
  };
}

export interface DeepgramSTTSpeechStarted {
  type: "SpeechStarted";
  channel_index: [number];
  timestamp: number;
}

export interface DeepgramSTTUtteranceEnd {
  type: "UtteranceEnd";
  channel_index: [number];
  last_word_end: number;
}

export interface DeepgramSTTMetadata {
  type: "Metadata";
  transaction_key: string;
  request_id: string;
  sha256: string;
  created: string;
  duration: number;
  channels: number;
}

export interface DeepgramSTTError {
  type: "Error";
  description: string;
  message: string;
  variant: string;
}

export type DeepgramSTTMessage =
  | DeepgramSTTTranscript
  | DeepgramSTTSpeechStarted
  | DeepgramSTTUtteranceEnd
  | DeepgramSTTMetadata
  | DeepgramSTTError;

/**
 * Deepgram WebSocket message types for TTS.
 */
export interface DeepgramTTSFlushed {
  type: "Flushed";
}

export interface DeepgramTTSCleared {
  type: "Cleared";
}

export interface DeepgramTTSWarning {
  type: "Warning";
  warn_code: string;
  warn_msg: string;
}

export interface DeepgramTTSError {
  type: "Error";
  err_code: string;
  err_msg: string;
}

export type DeepgramTTSMessage =
  | DeepgramTTSFlushed
  | DeepgramTTSCleared
  | DeepgramTTSWarning
  | DeepgramTTSError;
