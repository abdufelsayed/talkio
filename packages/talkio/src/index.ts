/**
 * talkio
 *
 * A TypeScript package for building real-time voice AI agents.
 *
 * This package provides orchestration for Speech-to-Text (STT), Language Models (LLM),
 * and Text-to-Speech (TTS) providers, with automatic turn management, interruption detection,
 * and conversation state management.
 *
 * ## Features
 *
 * - **Provider-agnostic**: Bring your own STT, LLM, and TTS providers
 * - **Type-safe**: Compile-time validation of audio formats and provider compatibility
 * - **Real-time**: Streaming audio and text for low-latency conversations
 * - **Turn management**: Automatic handling of user and AI turns
 * - **Interruption**: Users can interrupt the agent while it's speaking
 * - **Observability**: Comprehensive events and metrics for monitoring
 * - **Flexible**: Optional VAD and turn detector providers for advanced use cases
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createAgent } from "talkio";
 * import { createDeepgram } from "@talkio/deepgram";
 *
 * const deepgram = createDeepgram({ apiKey: process.env.DEEPGRAM_API_KEY });
 *
 * const agent = createAgent({
 *   stt: deepgram.stt({ model: "nova-3" }),
 *   llm: myLLMProvider,
 *   tts: deepgram.tts({ model: "aura-2-thalia-en" }),
 *   onEvent: (event) => {
 *     switch (event.type) {
 *       case "human-turn:ended":
 *         console.log("User:", event.transcript);
 *         break;
 *       case "ai-turn:sentence":
 *         console.log("Agent:", event.sentence);
 *         break;
 *     }
 *   },
 * });
 *
 * agent.start();
 * agent.sendAudio(audioChunk); // Send audio from microphone
 * agent.stop();
 * ```
 *
 * @packageDocumentation
 */

export { createAgent } from "./agent/create-agent";
export type { Agent, AgentState } from "./agent/create-agent";

export type {
  AssistantMessage,
  FilePart,
  ImagePart,
  Message,
  SystemMessage,
  TextPart,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  UserMessage,
} from "./types/common";

export type {
  AgentConfig,
  AudioConfig,
  AudioEncoding,
  AudioFormat,
  Channels,
  CompressedEncoding,
  ContainerEncoding,
  InterruptionConfig,
  NormalizedAgentConfig,
  NormalizedAudioConfig,
  NormalizedAudioFormat,
  PCMEncoding,
  SampleRate,
  SilenceConfig,
  TelephonyEncoding,
  TimeoutConfig,
} from "./types/config";

export {
  DEFAULT_AUDIO_CONFIG,
  DEFAULT_AUDIO_FORMAT,
  normalizeAudioConfig,
  normalizeFormat,
} from "./types/config";

export type {
  AITurnAudioEvent,
  AITurnEndedEvent,
  AITurnEvent,
  AITurnInterruptedEvent,
  AITurnSentenceEvent,
  AITurnStartedEvent,
  AITurnTokenEvent,
  AgentErrorEvent,
  AgentEvent,
  AgentLifecycleEvent,
  AgentStartedEvent,
  AgentStoppedEvent,
  DebugEvent,
  HumanTurnAbandonedEvent,
  HumanTurnEndedEvent,
  HumanTurnEvent,
  HumanTurnStartedEvent,
  HumanTurnTranscriptEvent,
  PublicAgentEvent,
  SilenceDetectedEvent,
  SilenceEvent,
  VADProbabilityEvent,
} from "./types/events";

export type {
  AITurnMetrics,
  AgentMetrics,
  AudioMetrics,
  ContentMetrics,
  ErrorMetrics,
  HumanTurnMetrics,
  LatencyMetrics,
  SessionMetrics,
  TurnStatistics,
} from "./types/metrics";

export type {
  BaseProvider,
  LLMContext,
  LLMFunction,
  LLMInput,
  LLMProvider,
  ProviderMetadata,
  ProviderType,
  STTContext,
  STTProvider,
  STTProviderMetadata,
  TTSContext,
  TTSProvider,
  TTSProviderMetadata,
  TurnDetectorContext,
  TurnDetectorProvider,
  VADContext,
  VADProvider,
} from "./providers/types";

export { isLLMFunction, isLLMProvider } from "./providers/types";

export {
  createCustomLLMProvider,
  createCustomSTTProvider,
  createCustomTTSProvider,
  createCustomTurnDetectorProvider,
  createCustomVADProvider,
} from "./providers/factories";

export type {
  CreateCustomLLMProviderOptions,
  CreateCustomSTTProviderOptions,
  CreateCustomTTSProviderOptions,
  CreateCustomTurnDetectorProviderOptions,
  CreateCustomVADProviderOptions,
} from "./providers/types";

// Audio utilities
export type {
  AudioDecoder,
  AudioInput,
  AudioInputConfig,
  AudioPreprocessor,
  AudioPreprocessorOptions,
  DecodedAudio,
} from "./audio";

export {
  alawToLinear16,
  // Decoder
  createAudioDecoder,
  // Preprocessor
  createAudioPreprocessor,
  // Conversions
  float32ToInt16,
  float32ToLinear16,
  inferEncodingFromTypedArray,
  int16ToFloat32,
  isRawPCM,
  isTypedArray,
  linear16ToAlaw,
  linear16ToFloat32,
  linear16ToMulaw,
  mulawToLinear16,
  requiresDecoding,
  resample,
  resampleInt16,
  stereoToMono,
} from "./audio";
