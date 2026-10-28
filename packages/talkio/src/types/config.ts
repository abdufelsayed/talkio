/**
 * Agent Configuration Types
 *
 * Defines the configuration types for creating voice AI agents.
 *
 * @module types/config
 */

import type { SimulatedClock } from "xstate";

import type { AudioConfig, AudioFormat, NormalizedAudioConfig } from "../audio/types";
import type {
  ExtractSTTInputFormat,
  ExtractTTSOutputFormat,
  LLMInput,
  STTProvider,
  TTSProvider,
  TurnDetectorProvider,
  VADProvider,
} from "../providers/types";
import type { Message } from "./common";
import type { AgentEvent, AgentTraceEvent } from "./events";

// Re-export AudioFormat types from audio module
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
} from "../audio/types";

export {
  DEFAULT_AUDIO_CONFIG,
  DEFAULT_AUDIO_FORMAT,
  normalizeAudioConfig,
  normalizeFormat,
} from "../audio/types";

/**
 * Interruption detection configuration.
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   stt, llm, tts,
 *   interruption: {
 *     enabled: true,
 *     minDurationMs: 200,
 *   },
 * });
 * ```
 */
export interface InterruptionConfig {
  /** Whether the user can interrupt the agent. @default true */
  enabled?: boolean;

  /**
   * Speech shorter than this is a false start (a cough, a door): the agent
   * resumes as soon as it ends. Longer speech interrupts once its words
   * confirm it. Set to 0 to interrupt on any detected speech without waiting
   * for words. @default 200
   */
  minDurationMs?: number;

  /**
   * Delay between detecting user speech and pausing the agent. 0 yields
   * immediately; a small delay lets very short sounds pass without a pause.
   * @default 0
   */
  speculativeCutoffMs?: number;

  /**
   * Words an interim transcript needs before it confirms an interruption.
   * Interruption cues ("stop", "wait", "actually") and final transcripts
   * confirm with fewer. @default 2
   */
  interimMinWords?: number;

  /**
   * Non-whitespace characters an interim transcript needs before it confirms
   * an interruption. @default 3
   */
  interimMinChars?: number;

  /**
   * After the user stops speaking without saying anything that confirms the
   * interruption, how long to wait for a late transcript before resuming.
   * @default 600
   */
  resumeAfterMs?: number;

  /**
   * Longest the agent stays paused for speech that produces no words (music,
   * a TV, noise) before it resumes. @default 3000
   */
  maxPendingMs?: number;

  /**
   * Decides whether overlapping speech interrupts, is a backchannel, or is
   * the agent's own echo. Defaults to a built-in classifier based on
   * acknowledgement phrases, interruption cues, word counts, and overlap with
   * what the agent is saying.
   */
  classifier?: InterruptionClassifier;

  /**
   * What happens to the agent's audio while an interruption is pending:
   * - `"pause"`: emit `audio:pause`, hold new audio, and continue seamlessly
   *   with `audio:resume` if the interruption is cancelled. Clients must be
   *   able to pause playback (for example `AudioContext.suspend()`).
   * - `"clear"`: emit `audio:clear` immediately, for transports that can only
   *   flush their playback buffer. A cancelled interruption replays the audio
   *   the client discarded. Replay needs PCM or telephony output, where the
   *   agent can tell how far playback got; with compressed output the
   *   discarded audio is lost.
   * @default "pause"
   */
  pendingAudio?: "pause" | "clear";
}

/**
 * - `interrupt`: the user wants the floor.
 * - `backchannel`: the user is only acknowledging the agent ("mm-hmm", "yeah").
 * - `echo`: the transcript is the agent's own voice picked up by the microphone.
 * - `undecided`: not enough words yet.
 */
export type InterruptionVerdict = "interrupt" | "backchannel" | "echo" | "undecided";

export interface InterruptionClassifierInput {
  /** What the user said while the agent was speaking, so far. */
  transcript: string;
  isFinal: boolean;
  /** What the agent was saying when the user spoke (its recent audible text). */
  agentText: string;
  /** How long the user has been speaking, in milliseconds. */
  speechMs: number;
  messages: readonly Message[];
}

/**
 * Decides whether overlapping user speech interrupts the agent. Return a
 * promise to classify with a model; the agent stays paused until it settles.
 * The built-in classifier is used when none is configured, and is exported as
 * `classifyInterruption` to wrap or extend.
 */
export type InterruptionClassifier = (
  input: InterruptionClassifierInput,
) => InterruptionVerdict | Promise<InterruptionVerdict>;

export type ResolvedInterruptionConfig = Required<Omit<InterruptionConfig, "classifier">> & {
  classifier?: InterruptionClassifier;
};

/**
 * When the agent takes the floor with a prediction-mode turn detector.
 *
 * After the user stops speaking, the agent waits between `minEndOfTurnDelayMs`
 * (the detector is confident the user is done) and `maxEndOfTurnDelayMs` (the
 * detector expects more), scaled by the latest end-of-turn probability.
 *
 * @example
 * ```typescript
 * turnTaking: { eagerness: "low" } // patient: dictation, callers reading numbers
 * ```
 */
export interface TurnTakingConfig {
  /**
   * Preset delay range:
   * - `"high"`: 200ms–1.2s, snappy but may cut off slow speakers
   * - `"medium"`: 400ms–2.5s
   * - `"low"`: 800ms–5s, for thoughtful speakers and long pauses
   * @default "medium"
   */
  eagerness?: "low" | "medium" | "high";

  /** Silence before ending the turn when the detector is confident. Overrides `eagerness`. */
  minEndOfTurnDelayMs?: number;

  /** Silence before ending the turn when the detector expects more speech. Overrides `eagerness`. */
  maxEndOfTurnDelayMs?: number;

  /**
   * Probability at which the detector counts as confident; probabilities at or
   * above it wait `minEndOfTurnDelayMs`. Detectors are calibrated differently,
   * so tune this per model. @default 0.7
   */
  endOfTurnThreshold?: number;

  /**
   * Start generating (and synthesizing) the reply when the user has probably
   * finished, before the turn is confirmed. The prepared reply stays silent
   * and is used if the turn ends as predicted, or discarded if the user keeps
   * talking. Triggered by `eagerTurnEnd` signals (for example Deepgram Flux
   * with `eagerEotThreshold`) or, for prediction-mode detectors, by
   * `eagerEndOfTurnThreshold`. Costs extra LLM and TTS calls when discarded.
   * @default true
   */
  preemptiveGeneration?: boolean;

  /**
   * Probability at which a prediction-mode detector starts preemptive
   * generation. Clamped to at most `endOfTurnThreshold`. @default 0.5
   */
  eagerEndOfTurnThreshold?: number;
}

export type ResolvedTurnTakingConfig = Required<Omit<TurnTakingConfig, "eagerness">>;

/**
 * How the agent tracks what the listener has heard.
 *
 * Released audio is assumed to play in real time once it arrives. Call
 * `agent.reportPlayback()` from the client for exact positions.
 */
export interface PlaybackConfig {
  /**
   * Time between releasing audio and the listener hearing it (network and
   * jitter buffer). Delays the estimated playhead so heard text is not
   * overstated. @default 0
   */
  outputLatencyMs?: number;
}

export type ResolvedPlaybackConfig = Required<PlaybackConfig>;

/**
 * Short phrases the agent says when its reply is slow to start, for example
 * while the LLM calls tools. Fillers are not part of the reply or history.
 * Each phrase is synthesized once and its audio replayed after that.
 */
export interface FillerConfig {
  /** @default false */
  enabled?: boolean;
  /**
   * How long the reply may stay silent before a filler. The wait starts over
   * when the user talks during it. @default 1200
   */
  afterMs?: number;
  /** Used in rotation. @default ["One moment.", "Let me check.", "Hmm, let me think."] */
  phrases?: string[];
}

export type ResolvedFillerConfig = Required<FillerConfig>;

/**
 * Acknowledgements the agent says in the user's pauses while they talk at
 * length ("mm-hmm"), like an attentive listener. Each phrase is synthesized
 * once and its audio replayed after that, so it plays right at the pause.
 *
 * Needs end-of-turn probabilities, from a turn detector or an STT provider with
 * native turn detection such as Deepgram Flux: the agent only backchannels
 * when the user is likely to continue. It never backchannels over a reply the
 * user can hear, and over a reply it is still preparing only with a phrase it
 * has already recorded. Without echo cancellation the agent ignores transcripts that only
 * repeat its backchannel, but the echo still counts as the user's voice.
 */
export interface BackchannelConfig {
  /** @default false */
  enabled?: boolean;
  /** Used in rotation. @default ["Mm-hmm.", "Uh-huh.", "Okay.", "Right."] */
  phrases?: string[];
  /** User speech before the first backchannel of a turn, and between backchannels. @default 4000 */
  minSpeechMs?: number;
  /** How long the user must pause before the agent backchannels. @default 400 */
  pauseMs?: number;
  /** Highest end-of-turn probability at which a pause counts as mid-thought. @default 0.3 */
  maxEndOfTurnProbability?: number;
}

export type ResolvedBackchannelConfig = Required<BackchannelConfig>;

/**
 * Timeout configuration for provider operations.
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   stt, llm, tts,
 *   timeout: {
 *     llmMs: 30000,  // 30 seconds for LLM
 *     ttsMs: 10000,  // 10 seconds for TTS
 *   },
 * });
 * ```
 */
export interface TimeoutConfig {
  /** Timeout for LLM generation in milliseconds. Undefined disables the timeout. */
  llmMs?: number;

  /** Timeout for TTS synthesis in milliseconds. Undefined disables the timeout. */
  ttsMs?: number;
}

export interface ObservabilityConfig {
  level?: "off" | "events" | "trace";
  onTrace?: (event: AgentTraceEvent) => void;
}

/**
 * Silence detection configuration.
 *
 * Detects when user is silent for too long while agent is listening,
 * triggering automatic prompts to re-engage the user.
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   stt, llm, tts,
 *   silence: {
 *     enabled: true,
 *     timeoutMs: 5000,
 *     startMode: "afterFirstSpeech",
 *     promptMessage: "Are you still there?",
 *     maxPrompts: 3,
 *   },
 * });
 * ```
 */
export interface SilenceConfig {
  /** Whether silence detection is enabled. @default false */
  enabled?: boolean;

  /** Duration of silence in milliseconds before triggering. @default 5000 */
  timeoutMs?: number;

  /**
   * When to start the silence timer:
   * - "always": Start timer immediately when agent begins listening
   * - "afterFirstSpeech": Start timer only after user has spoken at least once
   * @default "afterFirstSpeech"
   */
  startMode?: "always" | "afterFirstSpeech";

  /** Message to speak when silence is detected. @default "Are you still there?" */
  promptMessage?: string;

  /** Maximum number of silence prompts before giving up. @default 3 */
  maxPrompts?: number;
}

/**
 * Configuration for {@link createAgent}.
 *
 * @typeParam STT - The STT provider type (inferred from stt property)
 * @typeParam TTS - The TTS provider type (inferred from tts property)
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   stt: deepgram.stt({ model: "nova-3" }),
 *   llm: myLLMProvider,
 *   tts: deepgram.tts({ model: "aura-2-thalia-en" }),
 *   vad: myVADProvider,
 *   turnDetector: myTurnDetector,
 *   interruption: { enabled: true, minDurationMs: 200 },
 *   audio: {
 *     input: { encoding: "linear16", sampleRate: 16000 },
 *     output: { encoding: "linear16", sampleRate: 24000 },
 *   },
 *   onEvent: (event) => console.log(event),
 * });
 * ```
 */
export interface AgentConfig<
  STT extends STTProvider<AudioFormat> = STTProvider,
  TTS extends TTSProvider<AudioFormat> = TTSProvider,
> {
  /**
   * **Required.** Speech-to-Text provider.
   *
   * Transcribes user speech into text. Must implement the {@link STTProvider} interface.
   * The provider's supported input formats determine which audio encodings are allowed
   * in the `audio.input` configuration.
   *
   * @example
   * ```typescript
   * import { createDeepgram } from "@talkio/deepgram";
   * const deepgram = createDeepgram({ apiKey: "..." });
   * stt: deepgram.stt({ model: "nova-3" })
   * ```
   */
  stt: STT;

  /**
   * **Required.** Language Model provider or function.
   *
   * Generates responses based on conversation history. Can be either:
   * - A full {@link LLMProvider} object with metadata and generate method
   * - A simple {@link LLMFunction} that uses `ctx.signal` for cancellation
   *
   * @example Using a provider object
   * ```typescript
   * const llm = createOpenAILLM({ apiKey: "...", model: "gpt-4o" });
   * ```
   *
   * @example Using a function
   * ```typescript
   * const llm: LLMFunction = async (ctx) => {
   *   const response = await openai.chat.completions.create({
   *     model: "gpt-4",
   *     messages: ctx.messages,
   *     stream: true,
   *   }, { signal: ctx.signal });
   *   // Stream tokens using ctx.token(), ctx.sentence(), ctx.complete()
   * };
   * ```
   */
  llm: LLMInput;

  /**
   * **Required.** Text-to-Speech provider.
   *
   * Synthesizes text into speech audio. Must implement the {@link TTSProvider} interface.
   * The provider's supported output formats determine which audio encodings are allowed
   * in the `audio.output` configuration.
   *
   * @example
   * ```typescript
   * import { createDeepgram } from "@talkio/deepgram";
   * const deepgram = createDeepgram({ apiKey: "..." });
   * tts: deepgram.tts({ model: "aura-2-thalia-en" })
   * ```
   */
  tts: TTS;

  /**
   * **Optional.** Voice Activity Detection provider.
   *
   * If not provided, the STT provider's built-in VAD is used as fallback.
   * Dedicated VAD providers (like Silero) can provide faster interruption detection
   * by running client-side without waiting for STT processing.
   *
   * @example
   * ```typescript
   * import { createSileroVAD } from "@talkio/silero";
   * vad: createSileroVAD({ threshold: 0.5 })
   * ```
   */
  vad?: VADProvider;

  /**
   * **Optional.** Turn Detector provider.
   *
   * If not provided, the STT provider's final transcript marks turn end.
   * Custom turn detectors can implement semantic turn detection (e.g., detecting
   * question endings faster) or other advanced turn-taking logic.
   *
   * @example
   * ```typescript
   * turnDetector: createCustomTurnDetectorProvider({
   *   name: "MyTurnDetector",
   *   // ... implementation
   * })
   * ```
   */
  turnDetector?: TurnDetectorProvider;

  /**
   * **Optional.** When the agent takes the floor with a prediction-mode turn detector.
   */
  turnTaking?: TurnTakingConfig;

  /**
   * **Optional.** How the agent tracks what the listener has heard.
   */
  playback?: PlaybackConfig;

  /**
   * **Optional.** Phrases the agent says when its reply is slow to start.
   */
  fillers?: FillerConfig;

  /**
   * **Optional.** Acknowledgements the agent says while the user talks at length.
   */
  backchannels?: BackchannelConfig;

  /**
   * **Optional.** Interruption detection configuration.
   *
   * Controls whether users can interrupt the agent while it's speaking.
   * When enabled, the agent will stop speaking and start listening when
   * it detects user speech during an AI turn.
   *
   * @example
   * ```typescript
   * interruption: {
   *   enabled: true,
   *   minDurationMs: 200, // Ignore sounds shorter than 200ms
   * }
   * ```
   */
  interruption?: InterruptionConfig;

  /**
   * **Optional.** Silence detection configuration.
   *
   * Detects when user is silent for too long while agent is listening
   * and triggers automatic prompts to re-engage the user.
   *
   * @example
   * ```typescript
   * silence: {
   *   enabled: true,
   *   timeoutMs: 5000,
   *   promptMessage: "Are you still there?",
   *   maxPrompts: 3,
   * }
   * ```
   */
  silence?: SilenceConfig;

  /**
   * **Optional.** Timeout configuration for provider operations.
   *
   * Prevents the agent from hanging indefinitely if a provider
   * doesn't respond. When a timeout occurs, an error event is emitted.
   *
   * @example
   * ```typescript
   * timeout: {
   *   llmMs: 30000,  // 30 second timeout for LLM
   *   ttsMs: 10000,  // 10 second timeout for TTS
   * }
   * ```
   */
  timeout?: TimeoutConfig;

  observability?: ObservabilityConfig;

  /**
   * **Optional.** Audio configuration with separate input and output formats.
   *
   * If omitted, the provider's default formats are used:
   * - Input format defaults to `stt.metadata.defaultInputFormat`
   * - Output format defaults to `tts.metadata.defaultOutputFormat`
   *
   * Only `encoding` is required in each format; `sampleRate` and `channels`
   * have sensible defaults based on the encoding type.
   *
   * **TypeScript narrows the allowed encodings** based on the selected providers:
   * - Input encoding must be supported by the STT provider
   * - Output format must be supported by the TTS provider
   *
   * @example
   * ```typescript
   * audio: {
   *   input: { encoding: "linear16", sampleRate: 16000 },  // STT input
   *   output: { encoding: "linear16", sampleRate: 24000 }, // TTS output
   * }
   * ```
   */
  audio?: AudioConfig<ExtractSTTInputFormat<STT>, ExtractTTSOutputFormat<TTS>>;

  /**
   * **Optional.** Event handler callback for all agent events.
   *
   * Called for all public events (lifecycle, human turn, AI turn, debug).
   * Use this for observability, logging, UI updates, and monitoring.
   *
   * @param event - The agent event that occurred (see {@link AgentEvent})
   *
   * @example
   * ```typescript
   * onEvent: (event) => {
   *   switch (event.type) {
   *     case "human-turn:ended":
   *       console.log("User:", event.transcript);
   *       break;
   *     case "ai-turn:sentence":
   *       console.log("Agent:", event.sentence);
   *       break;
   *     case "agent:error":
   *       console.error("Error:", event.error, "from", event.source);
   *       break;
   *   }
   * }
   * ```
   */
  onEvent?: (event: AgentEvent) => void;

  /**
   * **Optional.** Maximum number of messages to retain in conversation history.
   *
   * When the message count exceeds this limit, older messages are removed
   * to prevent unbounded memory growth in long-running agents.
   * System messages are preserved when trimming.
   *
   * @default 100
   */
  maxMessages?: number;

  /**
   * **Optional.** Enable debug logging for internal events.
   *
   * When `true`, logs internal state machine events, audio chunk counts,
   * and provider callbacks to the console. Useful for debugging audio
   * flow and understanding agent behavior.
   *
   * @default false
   */
  debug?: boolean;

  /**
   * **Optional.** Custom clock for the XState actor system.
   *
   * Pass a `SimulatedClock` in tests to control time deterministically for
   * delayed events and timeouts managed by the actor system.
   */
  simulatedClock?: SimulatedClock;
}

/**
 * Normalized agent config where audio is always defined with all format fields.
 * Used internally by the agent machine context.
 *
 * @typeParam InputFormat - The input format type (from STT provider)
 * @typeParam OutputFormat - The output format type (from TTS provider)
 */
export type NormalizedAgentConfig<
  InputFormat extends AudioFormat = AudioFormat,
  OutputFormat extends AudioFormat = AudioFormat,
> = Omit<
  AgentConfig<STTProvider<InputFormat>, TTSProvider<OutputFormat>>,
  "audio" | "interruption" | "turnTaking" | "playback" | "fillers" | "backchannels"
> & {
  audio: NormalizedAudioConfig;
  interruption: ResolvedInterruptionConfig;
  turnTaking: ResolvedTurnTakingConfig;
  playback: ResolvedPlaybackConfig;
  fillers: ResolvedFillerConfig;
  backchannels: ResolvedBackchannelConfig;
  sessionId?: string;
};
