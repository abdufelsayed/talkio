/**
 * @talkio/deepgram
 *
 * Deepgram STT and TTS providers for talkio.
 *
 * This package provides ready-to-use Deepgram providers for speech-to-text
 * and text-to-speech that integrate seamlessly with the talkio orchestration library.
 *
 * ## Features
 *
 * - **Streaming STT**: Real-time speech transcription via WebSocket
 * - **Flux STT**: Conversational STT with native turn detection and eager end of turn
 * - **Streaming TTS**: Real-time speech synthesis via WebSocket
 * - **Type-safe**: Audio formats are validated at compile time
 * - **Multiple encodings**: Supports linear16, mulaw, alaw, opus, and more
 * - **VAD support**: Built-in voice activity detection
 * - **Flexible configuration**: Per-provider or shared settings
 *
 * ## Quick Start
 *
 * @example Using the factory method (recommended)
 * ```typescript
 * import { createDeepgram } from "@talkio/deepgram";
 * import { createAgent } from "talkio";
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
 * @example Direct imports
 * ```typescript
 * import { createDeepgramSTT, createDeepgramTTS } from "@talkio/deepgram";
 * import { createAgent } from "talkio";
 *
 * const agent = createAgent({
 *   stt: createDeepgramSTT({
 *     apiKey: process.env.DEEPGRAM_API_KEY,
 *     model: "nova-3",
 *   }),
 *   tts: createDeepgramTTS({
 *     apiKey: process.env.DEEPGRAM_API_KEY,
 *     model: "aura-2-thalia-en",
 *   }),
 *   llm: myLLMProvider,
 * });
 * ```
 *
 * @packageDocumentation
 */

// Main factory
export { createDeepgram } from "./deepgram-provider";

// Direct provider factories
export {
  createDeepgramFlux,
  type DeepgramFluxEncoding,
  type DeepgramFluxInputFormat,
} from "./deepgram-flux";
export { createDeepgramSTT, type DeepgramSTTInputFormat } from "./deepgram-stt";
export { createDeepgramTTS, type DeepgramTTSOutputFormat } from "./deepgram-tts";

// Types
export type {
  DeepgramFluxMessage,
  DeepgramFluxOptions,
  DeepgramFluxTurnInfo,
  DeepgramProvider,
  DeepgramProviderSettings,
  DeepgramSTTEncoding,
  DeepgramSTTOptions,
  DeepgramTTSEncoding,
  DeepgramTTSLinear16SampleRate,
  DeepgramTTSOptions,
  DeepgramTTSTelephonySampleRate,
} from "./types";
