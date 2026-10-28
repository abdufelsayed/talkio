/**
 * Provider Factories
 *
 * Build providers from plain options. STT and TTS factories infer the audio
 * formats a provider supports, so `createAgent` can check `audio.input` and
 * `audio.output` against them at compile time.
 *
 * @module providers/factories
 */

import type { AudioFormat } from "../audio/types";
import type {
  CreateLLMOptions,
  CreateSTTOptions,
  CreateTTSOptions,
  CreateVADOptions,
  LLMProvider,
  STTProvider,
  TTSProvider,
  VADProvider,
} from "./types";

/**
 * Create a speech-to-text provider.
 *
 * @example
 * ```typescript
 * const formats = [{ encoding: "linear16", sampleRate: 16000, channels: 1 }] as const;
 *
 * const stt = createSTT({
 *   name: "MySTT",
 *   supportedInputFormats: formats,
 *   defaultInputFormat: formats[0],
 *   start: (ctx) => {
 *     // ctx.transcript(text, isFinal), ctx.speechStart(), ctx.speechEnd()
 *     // ctx.turn.end() and friends, with turnDetection: true
 *   },
 *   stop: () => {},
 *   sendAudio: (audio) => {},
 * });
 * ```
 */
export function createSTT<InputFormat extends AudioFormat>(
  options: CreateSTTOptions<InputFormat>,
): STTProvider<InputFormat> {
  return {
    metadata: {
      name: options.name,
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
 * Create a language model provider. A plain {@link LLMFunction} works as well;
 * the provider form adds a name.
 *
 * @example
 * ```typescript
 * const llm = createLLM({
 *   name: "MyLLM",
 *   generate: (ctx) => myLLMService.streamText(ctx.messages, { signal: ctx.signal }),
 * });
 * ```
 */
export function createLLM(options: CreateLLMOptions): LLMProvider {
  return {
    metadata: { name: options.name },
    generate: options.generate,
  };
}

/**
 * Create a text-to-speech provider.
 *
 * @example
 * ```typescript
 * const formats = [{ encoding: "linear16", sampleRate: 24000, channels: 1 }] as const;
 *
 * const tts = createTTS({
 *   name: "MyTTS",
 *   supportedOutputFormats: formats,
 *   defaultOutputFormat: formats[0],
 *   start: (ctx) => {
 *     // ctx.audio(chunk), ctx.wordTimings(words), ctx.complete()
 *   },
 *   speak: (text, { requestId }) => {},
 *   flush: ({ requestId }) => {},
 *   clear: () => {},
 *   stop: () => {},
 * });
 * ```
 */
export function createTTS<OutputFormat extends AudioFormat>(
  options: CreateTTSOptions<OutputFormat>,
): TTSProvider<OutputFormat> {
  return {
    metadata: {
      name: options.name,
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
 * Create a voice activity detection provider.
 *
 * @example
 * ```typescript
 * const vad = createVAD({
 *   name: "MyVAD",
 *   start: (ctx) => {
 *     // ctx.audioFormat; ctx.speechStart(), ctx.speechEnd(), ctx.probability(p)
 *   },
 *   stop: () => {},
 *   sendAudio: (audio) => {},
 * });
 * ```
 */
export function createVAD(options: CreateVADOptions): VADProvider {
  return {
    metadata: { name: options.name },
    start: options.start,
    stop: options.stop,
    sendAudio: options.sendAudio,
  };
}
