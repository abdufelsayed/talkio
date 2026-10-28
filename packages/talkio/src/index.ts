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
 *       case "user-turn:ended":
 *         console.log("User:", event.transcript);
 *         break;
 *       case "agent-turn:sentence":
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
export { classifyInterruption } from "./agent/overlap";
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
  BackchannelConfig,
  Channels,
  CompressedEncoding,
  ContainerEncoding,
  FillerConfig,
  InterruptionClassifier,
  InterruptionClassifierInput,
  InterruptionConfig,
  InterruptionVerdict,
  NormalizedAudioFormat,
  PCMEncoding,
  PlaybackConfig,
  SampleRate,
  SilenceConfig,
  TelephonyEncoding,
  TimeoutConfig,
  TurnTakingConfig,
} from "./types/config";

export type {
  AgentTurnAudioEvent,
  AgentTurnEndedEvent,
  AgentTurnEvent,
  AgentTurnInterruptedEvent,
  AgentTurnInterruptionCancelledEvent,
  AgentTurnInterruptionPendingEvent,
  AgentTurnSentenceEvent,
  AgentTurnStartedEvent,
  AgentTurnTokenEvent,
  AgentBackchannelEvent,
  AgentErrorEvent,
  AgentEvent,
  AgentLifecycleEvent,
  AgentStartedEvent,
  AgentStoppedEvent,
  AgentTraceEvent,
  AudioClearEvent,
  AudioControlEvent,
  AudioPauseEvent,
  AudioResumeEvent,
  DebugEvent,
  UserTurnAbandonedEvent,
  UserTurnEndedEvent,
  UserTurnEvent,
  UserTurnStartedEvent,
  UserTurnTranscriptEvent,
  InterruptionCancelReason,
  PublicAgentEvent,
  SilenceDetectedEvent,
  SilenceEvent,
  VADProbabilityEvent,
} from "./types/events";

export type {
  AgentTurnMetrics,
  AgentMetrics,
  AudioMetrics,
  ContentMetrics,
  ErrorMetrics,
  UserTurnMetrics,
  LatencyMetrics,
  SessionMetrics,
  TurnStatistics,
} from "./types/metrics";

export type {
  LLMContext,
  LLMFunction,
  LLMInput,
  LLMProvider,
  LLMResult,
  ProviderMetadata,
  STTContext,
  STTProvider,
  STTProviderMetadata,
  TTSContext,
  TTSProvider,
  TTSProviderMetadata,
  TTSSpeakOptions,
  TTSWordTiming,
  Pause,
  TurnDetector,
  TurnDetectorContext,
  TurnDetectorFunction,
  TurnDetectorInput,
  TurnSignals,
  VADContext,
  VADProvider,
} from "./providers/types";

export { createLLM, createSTT, createTTS, createVAD } from "./providers/factories";

export type {
  CreateLLMOptions,
  CreateSTTOptions,
  CreateTTSOptions,
  CreateVADOptions,
} from "./providers/types";

export type { AudioInput } from "./audio";
