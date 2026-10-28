/**
 * Provider Factory Functions
 *
 * Helper functions for creating custom provider implementations.
 *
 * These factory functions simplify the creation of custom providers by handling
 * the boilerplate of provider metadata, type safety, and context management.
 * They're useful when you want to integrate your own STT, LLM, or TTS services
 * without implementing the full provider interface from scratch.
 *
 * **Available Factories**:
 * - `createCustomSTTProvider` - Create a custom speech-to-text provider
 * - `createCustomLLMProvider` - Create a custom language model provider
 * - `createCustomTTSProvider` - Create a custom text-to-speech provider
 * - `createCustomVADProvider` - Create a custom voice activity detection provider
 * - `createCustomTurnDetectorProvider` - Create a custom turn detector provider
 *
 * Each factory accepts options that define the provider's behavior and metadata,
 * and returns a fully typed provider that can be used with `createAgent()`.
 *
 * @example Creating a custom STT provider
 * ```typescript
 * const mySTT = createCustomSTTProvider({
 *   name: "MySTT",
 *   supportedInputFormats: [{ encoding: "linear16", sampleRate: 16000, channels: 1 }],
 *   defaultInputFormat: { encoding: "linear16", sampleRate: 16000, channels: 1 },
 *   start: (ctx) => {
 *     // Initialize connection
 *   },
 *   stop: () => {
 *     // Cleanup
 *   },
 *   sendAudio: (audio) => {
 *     // Send to service
 *   },
 * });
 * ```
 *
 * @module providers/factories
 */

import type { AudioFormat } from "../audio/types";
import type {
  CreateCustomLLMProviderOptions,
  CreateCustomSTTProviderOptions,
  CreateCustomTTSProviderOptions,
  CreateCustomVADProviderOptions,
  LLMProvider,
  STTProvider,
  TTSProvider,
  VADProvider,
} from "./types";

/**
 * Create a custom STT (Speech-to-Text) provider.
 *
 * Use this function to create a custom STT provider that integrates with
 * your own speech-to-text service or library. The provider must implement
 * the STT provider interface with start, stop, and sendAudio methods.
 *
 * @typeParam InputFormat - The audio format type(s) this provider accepts
 * @param options - Configuration options for the custom STT provider
 * @returns A typed STT provider that can be used in createAgent
 *
 * @example
 * ```typescript
 * // Define your supported formats as a const array
 * const formats = [
 *   { encoding: "linear16", sampleRate: 16000, channels: 1 },
 *   { encoding: "linear16", sampleRate: 24000, channels: 1 },
 * ] as const;
 *
 * const stt = createCustomSTTProvider({
 *   name: "MySTT",
 *   supportedInputFormats: formats,
 *   defaultInputFormat: formats[0],
 *   start: (ctx) => {
 *     // Initialize STT connection
 *     // ctx.audioFormat contains the selected format (normalized)
 *     // Use ctx.transcript(text, isFinal) to report transcripts
 *     // Use ctx.speechStart() and ctx.speechEnd() for VAD events
 *     // Use ctx.error(error) to report errors
 *     // Respect ctx.signal for cancellation
 *   },
 *   stop: () => {
 *     // Clean up resources, close connections
 *   },
 *   sendAudio: (audio) => {
 *     // Send audio (ArrayBuffer) to your STT service
 *     // Audio is already in the configured format
 *   },
 * });
 * ```
 */
export function createCustomSTTProvider<InputFormat extends AudioFormat>(
  options: CreateCustomSTTProviderOptions<InputFormat>,
): STTProvider<InputFormat> {
  return {
    metadata: {
      name: options.name,
      version: options.version ?? "1.0.0",
      type: "stt",
      supportedInputFormats: options.supportedInputFormats,
      defaultInputFormat: options.defaultInputFormat,
      turnDetection: options.turnDetection ?? false,
    },
    start: options.start,
    stop: options.stop,
    sendAudio: options.sendAudio,
  };
}

/**
 * Create a custom LLM (Language Model) provider.
 *
 * Use this function to create a custom LLM provider that integrates with
 * your own language model service or library.
 *
 * @param options - Configuration options for the custom LLM provider
 * @returns An LLM provider that can be used in createAgent
 *
 * @example
 * ```typescript
 * const llm = createCustomLLMProvider({
 *   name: "MyLLM",
 *   generate: (ctx) => myLLMService.streamText(ctx.messages, { signal: ctx.signal }),
 * });
 * ```
 */
export function createCustomLLMProvider(options: CreateCustomLLMProviderOptions): LLMProvider {
  return {
    metadata: {
      name: options.name,
      version: options.version ?? "1.0.0",
      type: "llm",
    },
    generate: options.generate,
  };
}

/**
 * Create a custom TTS (Text-to-Speech) provider.
 *
 * Use this function to create a custom TTS provider that integrates with
 * your own text-to-speech service or library. The provider must implement
 * streaming audio synthesis.
 *
 * @typeParam OutputFormat - The audio format type(s) this provider can output
 * @param options - Configuration options for the custom TTS provider
 * @returns A typed TTS provider that can be used in createAgent
 *
 * @example
 * ```typescript
 * // Define your supported formats as a const array
 * const formats = [
 *   { encoding: "linear16", sampleRate: 24000, channels: 1 },
 *   { encoding: "linear16", sampleRate: 48000, channels: 1 },
 * ] as const;
 *
 * const tts = createCustomTTSProvider({
 *   name: "MyTTS",
 *   supportedOutputFormats: formats,
 *   defaultOutputFormat: formats[0],
 *   start: (ctx) => {
 *     // Initialize TTS session and use ctx.audioChunk() for audio
 *   },
 *   speak: (text) => {
 *     // Send text to the active session
 *   },
 *   flush: () => {
 *     // Flush provider buffers
 *   },
 *   clear: () => {
 *     // Clear provider buffers on interruption
 *   },
 *   stop: () => {
 *     // Clean up resources
 *   },
 * });
 * ```
 */
export function createCustomTTSProvider<OutputFormat extends AudioFormat>(
  options: CreateCustomTTSProviderOptions<OutputFormat>,
): TTSProvider<OutputFormat> {
  return {
    metadata: {
      name: options.name,
      version: options.version ?? "1.0.0",
      type: "tts",
      supportedOutputFormats: options.supportedOutputFormats,
      defaultOutputFormat: options.defaultOutputFormat,
    },
    start: options.start,
    speak: options.speak,
    flush: options.flush,
    clear: options.clear,
    stop: options.stop,
  };
}

/**
 * Create a custom VAD (Voice Activity Detection) provider.
 *
 * VAD providers detect when the user is speaking, enabling faster
 * interruption detection and turn management. If not provided, the STT
 * provider's built-in VAD is used as fallback.
 *
 * @param options - Configuration options for the custom VAD provider
 * @returns A VAD provider that can be used in createAgent
 *
 * @example
 * ```typescript
 * const vad = createCustomVADProvider({
 *   name: "MyVAD",
 *   start: (ctx) => {
 *     // Initialize VAD model
 *     // Use ctx.speechStart() when speech detected
 *     // Use ctx.speechEnd(duration) when speech ends
 *     // Use ctx.speechProbability(prob) for visualization (optional)
 *   },
 *   stop: () => {
 *     // Clean up resources
 *   },
 *   processAudio: (audio) => {
 *     // Analyze audio frame for speech activity
 *     const probability = analyzeSpeech(audio);
 *     if (probability > 0.5) {
 *       ctx.speechStart();
 *     }
 *   },
 * });
 * ```
 */
export function createCustomVADProvider(options: CreateCustomVADProviderOptions): VADProvider {
  return {
    metadata: {
      name: options.name,
      version: options.version ?? "1.0.0",
      type: "vad",
    },
    start: options.start,
    stop: options.stop,
    processAudio: options.processAudio,
  };
}
