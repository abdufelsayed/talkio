/**
 * Deepgram Provider Factory
 *
 * Main factory function for creating a Deepgram provider instance with shared settings.
 *
 * This module provides a convenient way to create both STT and TTS providers
 * that share the same configuration (API key, base URL, etc.). The returned
 * provider instance has factory methods (`stt()` and `tts()`) for creating
 * individual providers with shared or overridden settings.
 *
 * **Usage Pattern**:
 * 1. Create a Deepgram provider instance with shared settings
 * 2. Use the factory methods to create STT and TTS providers
 * 3. Pass the providers to `createAgent()`
 *
 * This approach is useful when you want to use both Deepgram STT and TTS
 * with the same API key and base URL, reducing configuration duplication.
 *
 * @module deepgram/deepgram-provider
 */

import { createDeepgramFlux } from "./deepgram-flux";
import { createDeepgramSTT } from "./deepgram-stt";
import { createDeepgramTTS } from "./deepgram-tts";
import type {
  DeepgramFluxOptions,
  DeepgramProvider,
  DeepgramProviderSettings,
  DeepgramSTTOptions,
  DeepgramTTSOptions,
} from "./types";

/**
 * Create a Deepgram provider instance.
 *
 * The returned provider has factory methods for creating STT and TTS providers
 * that share the same configuration (API key, base URL, etc.). This is useful
 * when you want to use both Deepgram STT and TTS with shared settings.
 *
 * @param settings - Optional provider settings (API key, base URL)
 *   These settings are used as defaults for individual STT/TTS providers.
 *   Individual providers can override these settings.
 * @returns Deepgram provider instance with `stt()` and `tts()` factory methods
 *
 * @example Basic usage
 * ```typescript
 * import { createDeepgram } from "@talkio/deepgram";
 *
 * const deepgram = createDeepgram({
 *   apiKey: process.env.DEEPGRAM_API_KEY,
 * });
 *
 * const agent = createAgent({
 *   stt: deepgram.stt({ model: "nova-3" }),
 *   tts: deepgram.tts({ model: "aura-2-thalia-en" }),
 *   llm: myLLMProvider,
 * });
 * ```
 *
 * @example With custom base URL
 * ```typescript
 * const deepgram = createDeepgram({
 *   apiKey: process.env.DEEPGRAM_API_KEY,
 *   baseUrl: "api.deepgram.com", // Custom base URL for enterprise/proxy
 * });
 * ```
 */
export function createDeepgram(settings: DeepgramProviderSettings = {}): DeepgramProvider {
  return {
    /**
     * Create a Speech-to-Text provider.
     *
     * Returns a typed provider that only accepts Deepgram-supported input formats.
     * The provider connects to Deepgram's streaming WebSocket API for real-time transcription.
     *
     * @param options - STT configuration options (model, language, API key, etc.)
     * @returns A typed STT provider that can be used in createAgent
     *
     * @example
     * ```typescript
     * const stt = deepgram.stt({
     *   model: "nova-3",
     *   language: "en",
     *   interimResults: true,
     * });
     * ```
     */
    stt: (options: DeepgramSTTOptions) => createDeepgramSTT(options, settings),
    /**
     * Create a Text-to-Speech provider.
     *
     * Returns a typed provider that only accepts Deepgram-supported output formats.
     * The provider connects to Deepgram's streaming WebSocket API for real-time synthesis.
     *
     * @param options - TTS configuration options (model, encoding, sample rate, API key, etc.)
     * @returns A typed TTS provider that can be used in createAgent
     *
     * @example
     * ```typescript
     * const tts = deepgram.tts({
     *   model: "aura-2-thalia-en",
     *   encoding: "linear16",
     *   sampleRate: 24000,
     * });
     * ```
     */
    tts: (options: DeepgramTTSOptions) => createDeepgramTTS(options, settings),
    /**
     * Create a Flux conversational STT provider with native turn detection.
     *
     * @example
     * ```typescript
     * const stt = deepgram.flux({ eagerEotThreshold: 0.5 });
     * ```
     */
    flux: (options: DeepgramFluxOptions = {}) => createDeepgramFlux(options, settings),
  };
}
