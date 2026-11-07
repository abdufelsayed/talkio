/**
 * talkio
 *
 * A TypeScript package for building real-time voice AI agents.
 *
 * A fast talker model speaks with the user while a thinker model works in the
 * background with your tools. talkio orchestrates them with Speech-to-Text (STT)
 * and Text-to-Speech (TTS) providers, with turn management, interruption
 * detection, and one conversation timeline both models read.
 *
 * ## Features
 *
 * - **Provider-agnostic**: Bring your own STT, models, and TTS providers
 * - **Talker and thinker**: Fast replies, with tools and reasoning in the background
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
 *   talker: fastModel,
 *   thinker: frontierModel,
 *   instructions: "You are Ava, the receptionist at Acme Dental.",
 *   tools: { lookupAppointment, bookAppointment },
 *   tts: deepgram.tts({ model: "aura-2-thalia-en" }),
 *   onEvent: (event) => {
 *     switch (event.type) {
 *       case "user-turn:ended":
 *         console.log("User:", event.text);
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
  TimelineEntry,
  ToolCallPart,
  ToolMessage,
  ToolResultOutput,
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
  TimelineEntryEvent,
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
  LLMToolCall,
  ProviderMetadata,
  STTContext,
  STTProvider,
  STTProviderMetadata,
  Tool,
  ToolDefinition,
  ToolExecuteOptions,
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
