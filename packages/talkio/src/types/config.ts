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
  Tool,
  TTSProvider,
  TurnDetector,
  TurnDetectorInput,
  VADProvider,
} from "../providers/types";
import type { TimelineEntry } from "./common";
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
 * How the user interrupts the agent. Interruptions are on by default; pass
 * `interruption: false` to turn them off.
 *
 * @example
 * ```typescript
 * const agent = createAgent({ stt, talker, tts, interruption: { minWords: 3 } });
 * ```
 */
export interface InterruptionConfig {
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
  pauseAfterMs?: number;

  /**
   * Words an interim transcript needs before it confirms an interruption.
   * Interruption cues ("stop", "wait", "actually") and final transcripts
   * confirm with fewer. @default 2
   */
  minWords?: number;

  /**
   * Non-whitespace characters an interim transcript needs before it confirms
   * an interruption. @default 3
   */
  minChars?: number;

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
  timeline: readonly TimelineEntry[];
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
  enabled: boolean;
  classifier?: InterruptionClassifier;
};

/**
 * When the agent takes the floor with a turn detector that reports probabilities.
 *
 * After the user stops speaking, the agent waits between `minDelayMs` (the
 * detector is confident the user is done) and `maxDelayMs` (the detector
 * expects more), scaled by the latest end-of-turn probability.
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
  minDelayMs?: number;

  /** Silence before ending the turn when the detector expects more speech. Overrides `eagerness`. */
  maxDelayMs?: number;

  /**
   * End-of-turn probability at which the detector counts as confident;
   * probabilities at or above it wait `minDelayMs`. Detectors are calibrated
   * differently, so tune this per model. @default 0.7
   */
  threshold?: number;

  /**
   * Start generating (and synthesizing) the reply when the user has probably
   * finished, before the turn is confirmed. The prepared reply stays silent
   * and is used if the turn ends as predicted, or discarded if the user keeps
   * talking. Triggered by `eagerEnd` signals (for example Deepgram Flux
   * with `eagerEotThreshold`) or, for detectors that report probabilities, by
   * `eagerThreshold`. Costs extra talker and TTS calls when discarded.
   * @default true
   */
  preemptiveGeneration?: boolean;

  /**
   * End-of-turn probability at which the agent starts preemptive generation.
   * Clamped to at most `threshold`. @default 0.5
   */
  eagerThreshold?: number;
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
  /** Used in rotation. @default ["Mm-hmm.", "Uh-huh.", "Okay.", "Right."] */
  phrases?: string[];
  /** User speech before the first backchannel of a turn, and between backchannels. @default 4000 */
  minSpeechMs?: number;
  /** How long the user must pause before the agent backchannels. @default 400 */
  pauseMs?: number;
  /** Highest end-of-turn probability at which a pause counts as mid-thought. @default 0.3 */
  maxEndOfTurnProbability?: number;
}

export type ResolvedBackchannelConfig = Required<BackchannelConfig> & { enabled: boolean };

/**
 * Timeout configuration for provider operations.
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   stt, talker, tts,
 *   timeout: {
 *     talkerMs: 30000,
 *     ttsMs: 10000,
 *   },
 * });
 * ```
 */
export interface TimeoutConfig {
  /** Timeout for one talker run in milliseconds. Undefined disables the timeout. */
  talkerMs?: number;

  /**
   * Timeout for each thinker model call and each tool call, in milliseconds.
   * On by default: the thinker works one request at a time, so a call that
   * never returns would hold every later request. 0 disables it.
   * @default 120000
   */
  thinkerMs?: number;

  /** Timeout for TTS synthesis in milliseconds. Undefined disables the timeout. */
  ttsMs?: number;
}

/**
 * Lets the talker react when both sides go quiet: each silence is added to the
 * timeline and wakes the talker, which decides what to say ("Still there?",
 * "Still checking on that") or to stay quiet.
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   stt, talker, tts,
 *   silence: { afterMs: 8000, maxPrompts: 2 },
 * });
 * ```
 */
export interface SilenceConfig {
  /** How long both sides stay quiet before the talker is woken. @default 5000 */
  afterMs?: number;

  /**
   * When to start the silence timer:
   * - "always": Start timer immediately when agent begins listening
   * - "afterFirstSpeech": Start timer only after user has spoken at least once
   * @default "afterFirstSpeech"
   */
  startMode?: "always" | "afterFirstSpeech";

  /** Most silences in a row the talker is woken for. @default 3 */
  maxPrompts?: number;
}

export type ResolvedSilenceConfig = Required<SilenceConfig> & { enabled: boolean };

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
 *   talker: fastModel,
 *   thinker: frontierModel,
 *   instructions: "You are Ava, the receptionist at Acme Dental.",
 *   tools: { lookupAppointment, bookAppointment },
 *   tts: deepgram.tts({ model: "aura-2-thalia-en" }),
 *   vad: myVADProvider,
 *   turnDetector: myTurnDetector,
 *   interruption: { minDurationMs: 200 },
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
   * **Required.** The model that talks with the user: a fast model, since its
   * first words decide how quickly the agent answers. It answers what it can
   * from the instructions and the conversation, and hands anything that needs
   * tools or careful reasoning to the thinker while it keeps talking.
   *
   * @example
   * ```typescript
   * talker: (ctx) =>
   *   streamText({ model: anthropic("claude-haiku-5-5"), messages: ctx.messages, abortSignal: ctx.signal }).textStream
   * ```
   */
  talker: LLMInput;

  /**
   * **Optional.** The model that works in the background with `tools`: a
   * frontier model that follows the instructions and calls tools reliably. It
   * reads the whole conversation, works through the talker's requests one step
   * at a time, and writes what it finds for the talker to tell the user.
   * Defaults to the talker's model when `tools` are given.
   */
  thinker?: LLMInput;

  /**
   * **Optional.** Who the agent is and how it behaves: persona, procedures,
   * and guardrails. Both the talker and the thinker follow them.
   */
  instructions?: string;

  /**
   * **Optional.** Tools the thinker can call. AI SDK `tool()` definitions work
   * as they are.
   */
  tools?: Record<string, Tool>;

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
   * **Optional.** Decides when the user has finished speaking: a function that
   * scores pauses, a {@link TurnDetector}, or several of them (the highest
   * end-of-turn probability counts).
   *
   * Without one, the STT provider's own turn signals end the user's turn when it
   * has them (Deepgram Flux), and its final transcripts otherwise.
   *
   * @example
   * ```typescript
   * turnDetector: ({ transcript, messages, signal }) => model.score(transcript, messages, { signal })
   * ```
   */
  turnDetector?: TurnDetectorInput;

  /**
   * **Optional.** When the agent takes the floor with a turn detector that reports probabilities.
   */
  turnTaking?: TurnTakingConfig;

  /**
   * **Optional.** How the agent tracks what the listener has heard.
   */
  playback?: PlaybackConfig;

  /**
   * **Optional.** Acknowledgements the agent says while the user talks at length.
   * `true` or options turn them on. @default false
   */
  backchannels?: boolean | BackchannelConfig;

  /**
   * **Optional.** How the user interrupts the agent. On by default; `false`
   * turns interruptions off.
   *
   * @example
   * ```typescript
   * interruption: { minDurationMs: 300, minWords: 3 }
   * ```
   */
  interruption?: boolean | InterruptionConfig;

  /**
   * **Optional.** Wakes the talker when both sides go quiet.
   * `true` or options turn it on. @default false
   *
   * @example
   * ```typescript
   * silence: { afterMs: 8000, maxPrompts: 2 }
   * ```
   */
  silence?: boolean | SilenceConfig;

  /**
   * **Optional.** Timeout configuration for provider operations.
   *
   * Prevents the agent from hanging indefinitely if a provider
   * doesn't respond. When a timeout occurs, an error event is emitted.
   *
   * @example
   * ```typescript
   * timeout: {
   *   talkerMs: 30000,
   *   ttsMs: 10000,
   * }
   * ```
   */
  timeout?: TimeoutConfig;

  /**
   * **Optional.** Receives detailed trace events (provider calls, timing,
   * audio delivery) for debugging and latency analysis.
   */
  onTrace?: (event: AgentTraceEvent) => void;

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
   *     case "user-turn:ended":
   *       console.log("User:", event.text);
   *       break;
   *     case "agent-turn:sentence":
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
   * **Optional.** Clock for the agent's timers and timestamps.
   *
   * Pass an XState `SimulatedClock` in tests to control time deterministically.
   */
  clock?: SimulatedClock;
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
  | "audio"
  | "turnDetector"
  | "interruption"
  | "turnTaking"
  | "playback"
  | "backchannels"
  | "silence"
  | "instructions"
  | "tools"
> & {
  audio: NormalizedAudioConfig;
  instructions: string;
  tools: Record<string, Tool>;
  turnDetector?: TurnDetector;
  interruption: ResolvedInterruptionConfig;
  turnTaking: ResolvedTurnTakingConfig;
  playback: ResolvedPlaybackConfig;
  backchannels: ResolvedBackchannelConfig;
  silence: ResolvedSilenceConfig;
  sessionId?: string;
};
