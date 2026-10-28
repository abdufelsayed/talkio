/**
 * Provider Types
 *
 * Defines the type system and contracts for voice AI providers.
 *
 * Provider packages (e.g., `@talkio/deepgram`) implement these interfaces
 * via factory functions like `createDeepgramSTT({ apiKey, model })`.
 *
 * @module providers/types
 */

import type { AudioFormat, NormalizedAudioFormat } from "../audio/types";
import type { Message } from "../types/common";

/**
 * Provider type identifier.
 */
export type ProviderType = "stt" | "llm" | "tts" | "vad";

/**
 * Metadata included with every provider for debugging and identification.
 */
export interface ProviderMetadata {
  /**
   * Human-readable provider name.
   * @example "Deepgram", "OpenAI", "ElevenLabs"
   */
  name?: string;

  /**
   * Provider package version.
   * @example "1.0.0"
   */
  version?: string;

  /**
   * Provider type for categorization.
   */
  type: ProviderType;
}

/**
 * Base interface that all providers extend.
 * Contains metadata for debugging and identification.
 */
export interface BaseProvider {
  /**
   * Provider metadata for debugging and identification.
   */
  readonly metadata: ProviderMetadata;
}

/**
 * Turn boundary signals, reported by turn detectors and by STT providers with
 * native turn detection.
 */
export interface TurnSignals {
  /**
   * The user finished their turn and the agent should respond.
   * @param transcript - The turn's transcript; when omitted or empty, the agent
   *   uses the transcript it assembled from the STT provider.
   */
  end(transcript?: string): void;

  /**
   * The speech was not a real turn (noise, a cough) and should be discarded.
   * @param reason - Why the turn was abandoned (e.g. "too_short", "noise")
   */
  abandoned(reason: string): void;

  /**
   * The user has probably finished. The agent may start preparing its reply,
   * but stays silent until `end` confirms the turn.
   * @param transcript - The transcript the prepared reply is based on; defaults
   *   to the one the agent assembled.
   */
  eagerEnd(transcript?: string): void;

  /**
   * The user kept talking after `eagerEnd`; a prepared reply is discarded.
   */
  resumed(): void;

  /**
   * Probability (0-1) that the user has finished their turn. With a
   * `"probability"` turn detector the agent ends the turn after a delay that
   * shrinks as the probability grows (see `AgentConfig.turnTaking`); it also
   * decides when the agent backchannels.
   */
  probability(probability: number): void;
}

/**
 * Context provided to STT providers.
 * Contains emit methods for reporting transcription events.
 */
export interface STTContext {
  /**
   * Audio format configuration (always normalized with all fields defined).
   * STT providers should expect audio input in this format.
   */
  audioFormat: NormalizedAudioFormat;

  /**
   * Report a transcript update.
   * @param text - The transcribed text
   * @param isFinal - Whether this is a final transcript (true) or partial (false)
   */
  transcript(text: string, isFinal: boolean): void;

  /**
   * Report that speech has started (VAD event).
   * Used as fallback when no dedicated VAD provider is provided.
   */
  speechStart(): void;

  /**
   * Report that speech has ended (VAD event).
   * Used as fallback when no dedicated VAD provider is provided.
   */
  speechEnd(): void;

  /**
   * Report an error.
   */
  error(error: Error): void;

  /**
   * Turn boundaries, for providers that detect turns themselves (declared with
   * `metadata.turnDetection`). Ignored when a separate turn detector is configured.
   */
  turn: TurnSignals;

  /**
   * Abort signal for cancellation.
   * Providers should respect this signal and clean up when aborted.
   */
  signal: AbortSignal;
}

/**
 * STT provider metadata with supported input formats.
 * The InputFormat type parameter carries format information for compile-time validation.
 *
 * @example
 * ```typescript
 * // Provider declares its supported and default formats
 * const metadata: STTProviderMetadata<DeepgramInputFormat> = {
 *   name: "Deepgram",
 *   version: "1.0.0",
 *   type: "stt",
 *   supportedInputFormats: [
 *     { encoding: "linear16", sampleRate: 16000, channels: 1 },
 *     { encoding: "linear16", sampleRate: 24000, channels: 1 },
 *   ] as const,
 *   defaultInputFormat: { encoding: "linear16", sampleRate: 16000, channels: 1 },
 * };
 * ```
 */
export interface STTProviderMetadata<
  InputFormat extends AudioFormat = AudioFormat,
> extends ProviderMetadata {
  type: "stt";
  /**
   * Audio formats this provider accepts as input.
   * Used for runtime validation and documentation.
   */
  supportedInputFormats: readonly InputFormat[];
  /**
   * Default input format used when audio config is not specified.
   * This format is used if the user doesn't provide `audio.input` in the agent config.
   */
  defaultInputFormat: InputFormat;
  /**
   * Whether the provider reports turn boundaries through `ctx.turn`. When true
   * and no turn detector is configured, those signals end the user's turn
   * instead of final transcripts.
   */
  turnDetection?: boolean;
}

/**
 * Speech-to-Text provider interface.
 * Generic over InputFormat to enable compile-time audio format validation.
 *
 * @typeParam InputFormat - The audio format(s) this provider accepts
 *
 * @example
 * ```typescript
 * import { createDeepgramSTT } from '@talkio/deepgram';
 *
 * // DeepgramSTT is typed as STTProvider<DeepgramInputFormat>
 * const stt = createDeepgramSTT({
 *   apiKey: process.env.DEEPGRAM_API_KEY,
 *   model: 'nova-2',
 * });
 *
 * // TypeScript will error if audio.input doesn't match DeepgramInputFormat
 * createAgent({ stt, tts, llm, audio: { input: ..., output: ... } });
 * ```
 */
export interface STTProvider<InputFormat extends AudioFormat = AudioFormat> extends BaseProvider {
  /**
   * Provider metadata including supported input formats.
   *
   * Contains provider name, version, type, and the audio formats this provider accepts.
   * Used by the agent to validate audio configuration and select default formats.
   */
  readonly metadata: STTProviderMetadata<InputFormat>;

  /**
   * Start the STT session.
   * Initialize your STT connection and use context methods to report events.
   *
   * @param ctx - Context with emit methods, audio format, and abort signal
   */
  start(ctx: STTContext): void;

  /**
   * Stop the STT session and clean up resources.
   */
  stop(): void;

  /**
   * Send audio data to be transcribed.
   * Audio is in the format specified by `ctx.audioFormat` from `start()`.
   *
   * @param audio - Raw audio bytes (ArrayBuffer) in the configured input format
   */
  sendAudio(audio: ArrayBuffer): void;
}

/**
 * Extract the input format type from an STT provider.
 *
 * Utility type that extracts the `InputFormat` type parameter from an STT provider.
 * Used internally for compile-time audio format validation.
 *
 * @typeParam P - The STT provider type
 *
 * @example
 * ```typescript
 * type MySTTFormat = ExtractSTTInputFormat<typeof mySTTProvider>;
 * // MySTTFormat is the input format type that mySTTProvider accepts
 * ```
 */
export type ExtractSTTInputFormat<P> = P extends STTProvider<infer F> ? F : never;

/**
 * Context provided to LLM providers and functions.
 * Contains the conversation history, emit methods for reporting generation events,
 * and orchestration controls for filler phrases.
 */
export interface LLMContext {
  /**
   * Conversation history.
   * Contains all messages in the conversation up to this point.
   */
  messages: Message[];

  /**
   * Trigger speech immediately (for fillers, acknowledgments, etc.).
   * This will be synthesized and streamed while waiting for the main response.
   * @param text - Text to speak
   */
  say(text: string): void;

  /**
   * Interrupt/stop current speech streaming.
   * Use this when the main response arrives and a filler is still playing.
   */
  interrupt(): void;

  /**
   * Check if the agent is currently speaking.
   * Useful for deciding whether to trigger fillers.
   */
  isSpeaking(): boolean;

  /**
   * Whether this generation started before the user's turn was confirmed
   * (preemptive generation). Its output is held until the turn commits and is
   * discarded if the user keeps talking.
   */
  isSpeculative(): boolean;

  /**
   * Resolves `true` once the user's turn is confirmed, or `false` if this
   * generation was discarded. Resolves immediately for non-speculative
   * generations. Await it before side effects such as tool calls that book,
   * buy, or send something.
   */
  waitForCommit(): Promise<boolean>;

  /**
   * Report a token from the stream. Unless the provider reports its own
   * sentences, the agent splits streamed tokens into sentences for TTS.
   * @param token - The generated token
   */
  token(token: string): void;

  /**
   * Report a complete sentence to speak. Optional: the agent splits tokens
   * into sentences itself. Calling it takes over splitting for the rest of the
   * generation; call it in the same tick as the tokens that complete the
   * sentence so the agent never speaks the text first.
   * @param sentence - The complete sentence
   * @param index - Sentence index in the response
   */
  sentence(sentence: string, index: number): void;

  /**
   * Report that generation is complete.
   * @param fullText - The complete generated text
   */
  complete(fullText: string): void;

  /**
   * Report an error.
   */
  error(error: Error): void;

  /**
   * Abort signal for cancellation.
   */
  signal: AbortSignal;
}

/**
 * Language Model provider interface.
 * Provider packages implement this to integrate LLM services.
 * System prompts, tools, and model selection are handled inside the provider.
 *
 * Cancellation is handled via `ctx.signal` (AbortSignal). Providers should
 * listen to the signal and clean up when aborted.
 *
 * @example
 * ```typescript
 * import { createOpenAILLM } from '@talkio/provider-openai';
 *
 * const llm = createOpenAILLM({
 *   apiKey: process.env.OPENAI_API_KEY,
 *   model: 'gpt-4o',
 *   systemPrompt: 'You are a helpful assistant.',
 * });
 * ```
 */
export interface LLMProvider extends BaseProvider {
  /**
   * Generate a response for the given messages.
   * Stream tokens and sentences using context methods.
   *
   * @param messages - Conversation history (system, user, assistant, tool messages)
   * @param ctx - Context with emit methods, conversation controls, and abort signal
   */
  generate(messages: Message[], ctx: LLMContext): void;
}

/**
 * Function-based LLM provider.
 * A simpler alternative to LLMProvider for quick implementations.
 *
 * Cancellation is handled via ctx.signal (AbortSignal).
 *
 * @example
 * ```typescript
 * const llm: LLMFunction = async (ctx) => {
 *   const response = await openai.chat.completions.create({
 *     model: "gpt-4",
 *     messages: ctx.messages,
 *     stream: true,
 *   }, { signal: ctx.signal });
 *
 *   let fullText = "";
 *   for await (const chunk of response) {
 *     const token = chunk.choices[0]?.delta?.content || "";
 *     ctx.token(token);
 *     fullText += token;
 *   }
 *   ctx.complete(fullText);
 * };
 * ```
 */
export type LLMFunction = (ctx: LLMContext) => void;

/**
 * LLM input type - accepts either a full provider object or a simple function.
 */
export type LLMInput = LLMProvider | LLMFunction;

/**
 * Type guard to check if an LLM input is a provider object (not a function).
 *
 * Use this to narrow the type when you need to access provider-specific properties
 * like `metadata` or when you need to distinguish between provider objects and functions.
 *
 * @param llm - The LLM input to check
 * @returns `true` if the input is an LLMProvider object, `false` if it's a function
 *
 * @example
 * ```typescript
 * if (isLLMProvider(myLLM)) {
 *   console.log("Provider name:", myLLM.metadata.name);
 * } else {
 *   // myLLM is a function
 * }
 * ```
 */
export function isLLMProvider(llm: LLMInput): llm is LLMProvider {
  return typeof llm === "object" && llm !== null && "generate" in llm && "metadata" in llm;
}

/**
 * Type guard to check if an LLM input is a function.
 *
 * Use this to narrow the type when you need to call the function directly
 * or when you need to distinguish between provider objects and functions.
 *
 * @param llm - The LLM input to check
 * @returns `true` if the input is an LLMFunction, `false` if it's a provider object
 *
 * @example
 * ```typescript
 * if (isLLMFunction(myLLM)) {
 *   // myLLM is a function that can be called directly
 *   myLLM(ctx);
 * } else {
 *   // myLLM is a provider object
 *   myLLM.generate(messages, ctx);
 * }
 * ```
 */
export function isLLMFunction(llm: LLMInput): llm is LLMFunction {
  return typeof llm === "function";
}

/**
 * Context provided to TTS providers.
 * Contains emit methods for reporting synthesis events.
 */
export interface TTSContext {
  /**
   * Audio format configuration (always normalized with all fields defined).
   * TTS providers should produce audio output in this format.
   */
  audioFormat: NormalizedAudioFormat;

  /**
   * Report an audio chunk (for streaming TTS).
   * Audio should be in the configured output format.
   * @param audio - Raw audio bytes
   */
  audioChunk(audio: ArrayBuffer): void;

  /**
   * Report when words are spoken in the current request's audio. Optional,
   * but lets the agent record exactly what the listener heard when they
   * interrupt; without it the agent estimates from an even speech rate.
   */
  wordTimings(words: readonly TTSWordTiming[]): void;

  /**
   * Report that synthesis is complete.
   */
  complete(): void;

  /**
   * Report an error.
   */
  error(error: Error): void;

  /**
   * Abort signal for cancellation.
   */
  signal: AbortSignal;
}

/** When a word was spoken, relative to the start of its TTS request's audio. */
export interface TTSWordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TTSSpeakOptions {
  requestId: string;
}

/**
 * TTS provider metadata with supported output formats.
 * The OutputFormat type parameter carries format information for compile-time validation.
 *
 * @example
 * ```typescript
 * // Provider declares its supported and default formats
 * const metadata: TTSProviderMetadata<DeepgramOutputFormat> = {
 *   name: "Deepgram",
 *   version: "1.0.0",
 *   type: "tts",
 *   supportedOutputFormats: [
 *     { encoding: "linear16", sampleRate: 24000, channels: 1 },
 *     { encoding: "linear16", sampleRate: 48000, channels: 1 },
 *   ] as const,
 *   defaultOutputFormat: { encoding: "linear16", sampleRate: 24000, channels: 1 },
 * };
 * ```
 */
export interface TTSProviderMetadata<
  OutputFormat extends AudioFormat = AudioFormat,
> extends ProviderMetadata {
  type: "tts";
  /**
   * Audio formats this provider can output.
   * Used for runtime validation and documentation.
   */
  supportedOutputFormats: readonly OutputFormat[];
  /**
   * Default output format used when audio config is not specified.
   * This format is used if the user doesn't provide `audio.output` in the agent config.
   */
  defaultOutputFormat: OutputFormat;
}

/**
 * Text-to-Speech provider interface.
 * Generic over OutputFormat to enable compile-time audio format validation.
 *
 * @typeParam OutputFormat - The audio format(s) this provider can output
 *
 * @example
 * ```typescript
 * import { createElevenLabsTTS } from '@talkio/provider-elevenlabs';
 *
 * // ElevenLabsTTS is typed as TTSProvider<ElevenLabsOutputFormat>
 * const tts = createElevenLabsTTS({
 *   apiKey: process.env.ELEVENLABS_API_KEY,
 *   voiceId: 'rachel',
 * });
 *
 * // TypeScript will error if audio.output doesn't match ElevenLabsOutputFormat
 * createAgent({ stt, tts, llm, audio: { input: ..., output: ... } });
 * ```
 */
export interface TTSProvider<OutputFormat extends AudioFormat = AudioFormat> extends BaseProvider {
  /**
   * Provider metadata including supported output formats.
   *
   * Contains provider name, version, type, and the audio formats this provider can output.
   * Used by the agent to validate audio configuration and select default formats.
   */
  readonly metadata: TTSProviderMetadata<OutputFormat>;

  /**
   * Start the TTS session.
   */
  start(ctx: TTSContext): void;

  /**
   * Send text into the active TTS session.
   */
  speak(text: string, options: TTSSpeakOptions): void;

  /**
   * Flush buffered text so the provider starts producing audio.
   */
  flush(options: TTSSpeakOptions): void;

  /**
   * Clear provider-side speech buffers for hard barge-in.
   */
  clear(): void;

  /**
   * Stop the TTS session and clean up resources.
   */
  stop(): void;
}

/**
 * Extract the output format type from a TTS provider.
 *
 * Utility type that extracts the `OutputFormat` type parameter from a TTS provider.
 * Used internally for compile-time audio format validation.
 *
 * @typeParam P - The TTS provider type
 *
 * @example
 * ```typescript
 * type MyTTSFormat = ExtractTTSOutputFormat<typeof myTTSProvider>;
 * // MyTTSFormat is the output format type that myTTSProvider produces
 * ```
 */
export type ExtractTTSOutputFormat<P> = P extends TTSProvider<infer F> ? F : never;

/**
 * Context provided to VAD providers.
 * Contains emit methods for reporting speech activity.
 */
export interface VADContext {
  /**
   * Report that speech has started.
   */
  speechStart(): void;

  /**
   * Report that speech has ended.
   * @param duration - Duration of the speech in milliseconds
   */
  speechEnd(duration: number): void;

  /**
   * Report speech probability (for visualization).
   * Optional - only call if your VAD provides probability scores.
   * @param probability - Speech probability (0-1)
   */
  speechProbability(probability: number): void;

  /**
   * Report an error.
   */
  error(error: Error): void;

  /**
   * Abort signal for cancellation.
   */
  signal: AbortSignal;
}

/**
 * Voice Activity Detection provider interface.
 * Optional - if not provided, STT's built-in VAD is used as fallback.
 * Useful for client-side VAD (like Silero) for faster interruption detection.
 *
 * @example
 * ```typescript
 * import { createSileroVAD } from '@talkio/provider-silero';
 *
 * const vad = createSileroVAD({
 *   threshold: 0.5,
 *   minSpeechDuration: 250,
 * });
 * ```
 */
export interface VADProvider extends BaseProvider {
  /**
   * Start VAD processing.
   * @param ctx - Context with emit methods
   */
  start(ctx: VADContext): void;

  /**
   * Stop VAD processing.
   */
  stop(): void;

  /**
   * Process an audio frame.
   * @param audio - Audio data in the configured input format
   */
  processAudio(audio: ArrayBuffer): void;
}

/**
 * The user stopped talking. Passed to `TurnDetector.onPause` when the pause
 * starts, and again whenever the transcript changes during it.
 */
export interface Pause {
  /** What the user has said in this turn so far. */
  transcript: string;
  /** The conversation before this turn. */
  messages: readonly Message[];
  /** Aborts when the user resumes or the turn ends; a later result is ignored. */
  signal: AbortSignal;
}

/**
 * Returns how likely it is (0-1) that the user has finished their turn.
 *
 * @example
 * ```typescript
 * turnDetector: ({ transcript, messages, signal }) => model.score(transcript, messages, { signal })
 * ```
 */
export type TurnDetectorFunction = (pause: Pause) => number | Promise<number>;

/** Context provided to `TurnDetector.start`. */
export interface TurnDetectorContext {
  /** Format of the audio passed to `sendAudio` (the agent's input format). */
  audioFormat: NormalizedAudioFormat;
  /** Report turn signals at any time, for detectors that stream. */
  turn: TurnSignals;
  error(error: Error): void;
  signal: AbortSignal;
}

/**
 * Decides when the user has finished speaking. Every member is optional: a
 * detector implements what it reads.
 *
 * - Text models return a probability from `onPause`.
 * - Audio models keep the audio they need from `sendAudio` and score it in
 *   `onPause`.
 * - Streaming or remote detectors report through `ctx.turn` whenever they like.
 *
 * @example
 * ```typescript
 * const detector: TurnDetector = {
 *   name: "SmartTurn",
 *   async start(ctx) { model = await load(ctx.audioFormat); },
 *   sendAudio(audio) { window.push(audio); },
 *   onPause: ({ signal }) => model.predict(window.samples(), { signal }),
 * };
 * ```
 */
export interface TurnDetector {
  name?: string;

  /**
   * What the detector reports:
   * - `"probability"`: end-of-turn probabilities; the agent decides when the
   *   turn ends (see `AgentConfig.turnTaking`).
   * - `"decision"`: the detector ends turns itself with `ctx.turn.end()`.
   *
   * Either kind may call `ctx.turn.end()`. @default "probability"
   */
  output?: "probability" | "decision";

  /** Load models and open connections. A rejected promise is reported as an error. */
  start?(ctx: TurnDetectorContext): void | Promise<void>;

  stop?(): void;

  /** Score a pause. A returned number is reported as the end-of-turn probability. */
  onPause?(pause: Pause): number | void | Promise<number | void>;

  /** Every input audio chunk, in `ctx.audioFormat`. */
  sendAudio?(audio: ArrayBuffer): void;

  /** Every transcript update from the STT provider. */
  onTranscript?(text: string, isFinal: boolean): void;

  /** The user started or resumed speaking. */
  onSpeechStart?(): void;
}

/**
 * A turn detector: a function, a detector object, or several of them. With
 * several, the highest end-of-turn probability counts.
 */
export type TurnDetectorInput =
  | TurnDetector
  | TurnDetectorFunction
  | readonly (TurnDetector | TurnDetectorFunction)[];

/**
 * Options for creating a custom LLM provider.
 */
export interface CreateCustomLLMProviderOptions {
  /** Provider name for identification (e.g., "MyLLM", "CustomLLM") */
  name?: string;
  /** Provider version (defaults to "1.0.0") */
  version?: string;
  /**
   * Generate a response for the given messages.
   *
   * This function should:
   * - Stream tokens using `ctx.token(token)` as they're generated
   * - Optionally report sentences using `ctx.sentence(sentence, index)`; otherwise
   *   the agent splits tokens (or the `complete` text) into sentences
   * - Complete with `ctx.complete(fullText)` when done
   * - Use `ctx.say(text)` for filler phrases/acknowledgments
   * - Use `ctx.interrupt()` to stop current speech
   * - Report errors using `ctx.error(error)`
   * - Respect `ctx.signal` for cancellation
   *
   * @param messages - Conversation history (system, user, assistant, tool messages)
   * @param ctx - LLM context with emit methods and conversation controls
   */
  generate: (messages: Message[], ctx: LLMContext) => void;
}

/**
 * Options for creating a custom STT provider.
 *
 * @typeParam InputFormat - The audio format type(s) this provider accepts
 */
export interface CreateCustomSTTProviderOptions<InputFormat extends AudioFormat = AudioFormat> {
  /** Provider name for identification (e.g., "MySTT", "CustomSTT") */
  name?: string;
  /** Provider version (defaults to "1.0.0") */
  version?: string;
  /** Audio formats this provider accepts as input (must be a const array) */
  supportedInputFormats: readonly InputFormat[];
  /** Default input format used when audio config is not specified in createAgent */
  defaultInputFormat: InputFormat;
  /** Whether the provider reports turn boundaries through `ctx.turn` */
  turnDetection?: boolean;
  /** Start the STT session - initialize connections, set up listeners */
  start: (ctx: STTContext) => void;
  /** Stop the STT session - clean up resources, close connections */
  stop: () => void;
  /** Send audio data to be transcribed - called with audio chunks from the agent */
  sendAudio: (audio: ArrayBuffer) => void;
}

/**
 * Options for creating a custom TTS provider.
 *
 * @typeParam OutputFormat - The audio format type(s) this provider can output
 */
export interface CreateCustomTTSProviderOptions<OutputFormat extends AudioFormat = AudioFormat> {
  /** Provider name for identification (e.g., "MyTTS", "CustomTTS") */
  name?: string;
  /** Provider version (defaults to "1.0.0") */
  version?: string;
  /** Audio formats this provider can output (must be a const array) */
  supportedOutputFormats: readonly OutputFormat[];
  /** Default output format used when audio config is not specified in createAgent */
  defaultOutputFormat: OutputFormat;
  /** Start the TTS session - initialize connections, set up listeners */
  start: (ctx: TTSContext) => void;
  /** Send text into the active TTS session */
  speak: (text: string, options: TTSSpeakOptions) => void;
  /** Flush buffered text so synthesis begins */
  flush: (options: TTSSpeakOptions) => void;
  /** Clear provider-side speech buffers for interruption */
  clear: () => void;
  /** Stop the TTS session - clean up resources, close connections */
  stop: () => void;
}

/**
 * Options for creating a custom VAD provider.
 */
export interface CreateCustomVADProviderOptions {
  /** Provider name for identification (e.g., "MyVAD", "CustomVAD") */
  name?: string;
  /** Provider version (defaults to "1.0.0") */
  version?: string;
  /**
   * Start VAD processing.
   * Initialize your VAD model or service here.
   *
   * @param ctx - VAD context with emit methods
   */
  start: (ctx: VADContext) => void;
  /**
   * Stop VAD processing.
   * Clean up resources, close connections.
   */
  stop: () => void;
  /**
   * Process an audio frame for speech activity detection.
   *
   * Called with each audio chunk from the agent. Analyze the audio
   * and emit events:
   * - `ctx.speechStart()` when speech begins
   * - `ctx.speechEnd(duration)` when speech ends
   * - `ctx.speechProbability(prob)` for probability scores (optional)
   * - `ctx.error(error)` to report errors
   *
   * @param audio - Audio data (ArrayBuffer) in the configured input format
   */
  processAudio: (audio: ArrayBuffer) => void;
}
