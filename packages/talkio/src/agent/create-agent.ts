/**
 * Create Agent
 *
 * Public API for creating and managing voice AI agents.
 *
 * This module provides the main entry point for the talkio library. It exports
 * the `createAgent` function which creates a fully configured voice agent instance
 * that orchestrates STT, LLM, and TTS providers for real-time voice conversations.
 *
 * The agent manages the complete conversation lifecycle:
 * - Audio input processing and transcription
 * - Response generation via language models
 * - Speech synthesis and audio output
 * - Turn-taking and conversation state
 * - Interruption detection and handling
 * - Event emission for observability
 * - Metrics collection and reporting
 *
 * @module agent/create-agent
 */

import { nanoid } from "nanoid";
import { createActor } from "xstate";

import { float32ToLinear16 } from "../audio/conversions";
import type { AudioInput } from "../audio/preprocessor";
import { normalizeFormat, type AudioFormat } from "../audio/types";
import type { STTProvider, TTSProvider } from "../providers/types";
import type { AgentMachineOutput, Message } from "../types/common";
import type { AgentConfig } from "../types/config";
import type { PublicAgentEvent } from "../types/events";
import type { AgentMetrics, MetricsTrackingState } from "../types/metrics";
import { agentMachine } from "./machine";
import { getConfigNow } from "./time";

/**
 * Voice agent instance that orchestrates STT, LLM, and TTS providers.
 *
 * The agent manages the complete voice conversation flow:
 * - Receives audio input from the user
 * - Transcribes speech using the STT provider
 * - Generates responses using the LLM provider
 * - Synthesizes speech using the TTS provider
 * - Handles turn management, interruption detection, and conversation state
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   stt: mySTTProvider,
 *   llm: myLLMProvider,
 *   tts: myTTSProvider,
 *   onEvent: (event) => console.log(event),
 * });
 *
 * agent.start();
 * agent.sendAudio(audioChunk);
 * agent.stop();
 * ```
 */
export interface Agent {
  /**
   * Unique identifier for this agent instance.
   * Generated automatically when the agent is created.
   */
  readonly id: string;

  /**
   * ReadableStream of audio output chunks from the TTS provider.
   *
   * Yields ArrayBuffer chunks as they are produced by TTS.
   * Audio is encoded in the format specified by the audio configuration.
   * Use this stream to handle audio playback in your application.
   *
   * @example
   * ```typescript
   * const reader = agent.audioStream.getReader();
   * while (true) {
   *   const { done, value } = await reader.read();
   *   if (done) break;
   *   playAudio(value); // ArrayBuffer chunk in configured encoding
   * }
   * ```
   */
  readonly audioStream: ReadableStream<ArrayBuffer>;

  /**
   * Start the agent and initialize all providers.
   *
   * This method:
   * - Initializes the STT provider to begin listening for speech
   * - Starts the VAD provider (if configured) for voice activity detection
   * - Prepares the agent for processing audio input
   *
   * Must be called before sending audio data. The agent will emit
   * an `agent:started` event when initialization is complete.
   */
  start(): void;

  /**
   * Send audio data to the agent for processing.
   *
   * The audio will be:
   * - Automatically converted to the format expected by STT/VAD providers
   * - Processed by the STT provider for transcription
   * - Analyzed by the VAD provider (if configured) for speech detection
   * - Used for turn detection and interruption detection
   *
   * Accepts multiple input formats:
   * - `ArrayBuffer` - Raw audio bytes
   * - `Blob` - From MediaRecorder (webm, opus, etc.)
   * - `Float32Array` - From AudioWorklet/ScriptProcessor
   * - `Int16Array` - Raw PCM samples
   * - `Uint8Array` - Raw bytes
   * - `Buffer` - Node.js Buffer
   *
   * The agent automatically handles format conversion, resampling, and decoding
   * based on the configured input format.
   *
   * @param audio - Audio data in any supported format
   *
   * @example MediaRecorder (browser)
   * ```typescript
   * const mediaRecorder = new MediaRecorder(stream);
   * mediaRecorder.ondataavailable = (e) => agent.sendAudio(e.data);
   * ```
   *
   * @example AudioWorklet (browser)
   * ```typescript
   * processor.port.onmessage = (e) => agent.sendAudio(e.data);
   * ```
   *
   * @example Telephony (Node.js)
   * ```typescript
   * stream.on('data', (chunk) => agent.sendAudio(chunk));
   * ```
   */
  sendAudio(audio: AudioInput): void;

  /**
   * Stop the agent and clean up all resources.
   *
   * This method:
   * - Stops all active providers (STT, LLM, TTS, VAD, etc.)
   * - Closes the audio output stream
   * - Cleans up WebSocket connections and other resources
   * - Emits an `agent:stopped` event
   *
   * Should be called when the agent is no longer needed to prevent resource leaks.
   */
  stop(): void;

  /**
   * Subscribe to agent state changes.
   *
   * The callback is invoked whenever the agent's state changes, including:
   * - Message updates
   * - Transcript updates
   * - Metrics updates
   * - Status changes
   *
   * @param callback - Function called with the new state whenever it changes
   * @returns Unsubscribe function that stops receiving state updates
   *
   * @example
   * ```typescript
   * const unsubscribe = agent.subscribe((state) => {
   *   console.log("Agent is running:", state.isRunning);
   *   console.log("Current transcript:", state.partialTranscript);
   * });
   *
   * // Later, when done
   * unsubscribe();
   * ```
   */
  subscribe(callback: (state: AgentState) => void): () => void;

  /**
   * Get the current agent state snapshot.
   *
   * Returns a snapshot of the agent's current state without subscribing to updates.
   * Use this for one-time state checks or when you don't need continuous updates.
   *
   * @returns Current agent state snapshot
   *
   * @example
   * ```typescript
   * const state = agent.getSnapshot();
   * if (state.isRunning) {
   *   console.log("Agent is active");
   * }
   * ```
   */
  getSnapshot(): AgentState;
}

/**
 * Agent state snapshot providing a complete view of the agent's current state.
 *
 * This snapshot includes conversation history, current status, metrics, and more.
 * Use `agent.subscribe()` to receive updates when the state changes, or
 * `agent.getSnapshot()` to get the current state on demand.
 */
export interface AgentState {
  /**
   * Current agent state value.
   * Can be a simple string (e.g., "idle", "running") or a nested object
   * for hierarchical states (e.g., { running: "listening" }).
   */
  value: string | Record<string, unknown>;

  /**
   * Whether the agent is currently running and processing audio.
   * True when the agent is in an active state (listening, processing, speaking).
   */
  isRunning: boolean;

  /**
   * Whether the agent is currently speaking (TTS is active).
   * True when audio is being synthesized and streamed.
   */
  isSpeaking: boolean;

  /**
   * Complete conversation history.
   * Contains all messages exchanged between the user and the agent,
   * including system messages, user messages, and assistant responses.
   */
  messages: Message[];

  /**
   * Current partial transcript from the STT provider.
   * Updates in real-time as the user speaks. This is the latest
   * transcript, which may be partial (not yet finalized).
   */
  partialTranscript: string;

  /**
   * Agent lifecycle status.
   * - `"active"` - Agent is running and processing
   * - `"done"` - Agent has completed and reached a final state
   * - `"error"` - Agent encountered an error
   * - `"stopped"` - Agent has been stopped
   */
  status: "active" | "done" | "error" | "stopped";

  /**
   * Output produced when the agent reaches its final state (status === 'done').
   * Contains a summary of the conversation, including all messages and turn count.
   * Undefined when the agent is not in a done state.
   */
  output: AgentMachineOutput | undefined;

  /**
   * Cumulative metrics for the entire session.
   * Includes session duration, turn statistics, latency averages,
   * content totals, audio metrics, and error tracking.
   */
  metrics: AgentMetrics;
}

function isRunningState(value: string | Record<string, unknown>): boolean {
  if (value === "running") return true;
  if (typeof value === "object" && value !== null && "running" in value) return true;
  return false;
}

/**
 * Convert AudioInput to ArrayBuffer synchronously.
 *
 * For Blob inputs, this will throw - use the async version or
 * convert the Blob to ArrayBuffer before calling sendAudio.
 */
function toArrayBuffer(input: AudioInput, encoding: AudioFormat["encoding"]): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input;
  }

  if (input instanceof Float32Array) {
    if (encoding === "linear16") {
      return float32ToLinear16(input);
    }
    if (encoding === "float32") {
      const buffer = new ArrayBuffer(input.byteLength);
      new Float32Array(buffer).set(input);
      return buffer;
    }
  }

  if (input instanceof Int16Array || input instanceof Uint8Array) {
    const buffer = new ArrayBuffer(input.byteLength);
    new Uint8Array(buffer).set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    return buffer;
  }

  // Check for Node.js Buffer (has buffer, byteOffset, byteLength properties)
  if (
    typeof input === "object" &&
    input !== null &&
    "buffer" in input &&
    "byteOffset" in input &&
    "byteLength" in input
  ) {
    const bufferLike = input as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
    // Create a copy
    const buffer = new ArrayBuffer(bufferLike.byteLength);
    new Uint8Array(buffer).set(
      new Uint8Array(bufferLike.buffer, bufferLike.byteOffset, bufferLike.byteLength),
    );
    return buffer;
  }

  if (input instanceof Blob) {
    throw new Error(
      "Blob input requires async conversion. Use `await blob.arrayBuffer()` before calling sendAudio(), " +
        "or use MediaRecorder with a format that outputs ArrayBuffer directly.",
    );
  }

  throw new Error(`Unsupported audio input type: ${typeof input}`);
}

/**
 * Check if an event is internal (prefixed with "_")
 */
function isInternalEvent(event: { type: string }): boolean {
  return event.type.startsWith("_");
}

function computeAgentMetrics(metricsState: MetricsTrackingState, now: number): AgentMetrics {
  const m = metricsState;

  return {
    session: {
      startedAt: m.sessionStartedAt ?? 0,
      duration: m.sessionStartedAt ? now - m.sessionStartedAt : 0,
    },
    turns: {
      total: m.totalTurns,
      completed: m.completedTurns,
      interrupted: m.interruptedTurns,
      abandoned: m.abandonedTurns,
    },
    latency: {
      averageTimeToFirstToken:
        m.completedTurnsForAverage > 0 ? m.totalTimeToFirstToken / m.completedTurnsForAverage : 0,
      averageTimeToFirstAudio:
        m.completedTurnsForAverage > 0 ? m.totalTimeToFirstAudio / m.completedTurnsForAverage : 0,
      averageTurnDuration:
        m.completedTurnsForAverage > 0 ? m.totalTurnDuration / m.completedTurnsForAverage : 0,
    },
    content: {
      totalLLMTokens: m.totalLLMTokens,
      totalUserTranscriptChars: m.totalUserTranscriptChars,
      totalResponseChars: m.totalResponseChars,
    },
    audio: {
      totalUserSpeechDuration: m.totalUserSpeechDuration,
      totalAgentSpeakingDuration: m.totalAgentSpeakingDuration,
      totalAudioChunks: m.totalAudioChunks,
      totalAudioSamples: m.totalAudioSamples,
    },
    errors: {
      total: Object.values(m.errorsBySource).reduce((a, b) => a + b, 0),
      bySource: m.errorsBySource,
    },
  };
}

/**
 * Create a voice AI agent that orchestrates STT, LLM, and TTS providers.
 *
 * The agent manages the complete voice conversation lifecycle:
 * - Processes audio input through STT for transcription
 * - Generates responses using the LLM provider
 * - Synthesizes speech using the TTS provider
 * - Handles turn-taking, interruption detection, and conversation state
 *
 * @param config - Agent configuration including required providers (STT, LLM, TTS)
 *   and optional settings (VAD, turn detector, interruption, audio config, event handler)
 * @returns Agent instance ready to process voice conversations
 *
 * @example Basic usage
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
 *         console.log("User said:", event.transcript);
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
 * @example With custom audio configuration
 * ```typescript
 * const agent = createAgent({
 *   stt: mySTTProvider,
 *   llm: myLLMProvider,
 *   tts: myTTSProvider,
 *   audio: {
 *     input: { encoding: "linear16", sampleRate: 16000 },
 *     output: { encoding: "linear16", sampleRate: 24000 },
 *   },
 *   interruption: { enabled: true, minDurationMs: 200 },
 * });
 * ```
 */
export function createAgent<
  STT extends STTProvider<AudioFormat>,
  TTS extends TTSProvider<AudioFormat>,
>(config: AgentConfig<STT, TTS>): Agent {
  const id = nanoid();
  const inputFormat = normalizeFormat(
    config.audio?.input ?? config.stt.metadata.defaultInputFormat,
  );
  const outputFormat = normalizeFormat(
    config.audio?.output ?? config.tts.metadata.defaultOutputFormat,
  );
  const audioConfig = {
    input: inputFormat,
    output: outputFormat,
  };
  const interruptionMinDurationMs = config.interruption?.minDurationMs ?? 200;
  const speculativeCutoffMs = Math.min(
    Math.max(config.interruption?.speculativeCutoffMs ?? 0, 0),
    interruptionMinDurationMs,
  );
  const normalizedConfig = {
    ...config,
    audio: audioConfig,
    interruption: {
      enabled: config.interruption?.enabled ?? true,
      minDurationMs: interruptionMinDurationMs,
      speculativeCutoffMs,
    },
  };

  let audioStreamController: ReadableStreamDefaultController<ArrayBuffer> | null = null;
  const audioStream = new ReadableStream<ArrayBuffer>({
    start(controller) {
      audioStreamController = controller;
    },
  });
  const actor = createActor(agentMachine, {
    input: { config: normalizedConfig, audioStreamController },
    clock: config.simulatedClock,
  });

  // Track event subscription for cleanup
  const eventSubscription = actor.on("*", (event) => {
    if (!isInternalEvent(event)) {
      config.onEvent?.(event as PublicAgentEvent);
    }
  });

  let isStopped = false;

  return {
    id,
    audioStream,

    start() {
      if (isStopped) {
        throw new Error("Cannot start a stopped agent. Create a new agent instance.");
      }
      actor.start();
      actor.send({ type: "_agent:start", timestamp: getConfigNow(normalizedConfig) });
    },

    sendAudio(audio: AudioInput) {
      if (isStopped) return;
      // Convert input to ArrayBuffer synchronously
      const arrayBuffer = toArrayBuffer(audio, inputFormat.encoding);
      actor.send({
        type: "_audio:input",
        audio: arrayBuffer,
        timestamp: getConfigNow(normalizedConfig),
      });
    },

    stop() {
      if (isStopped) return;
      isStopped = true;

      // Send stop event and let machine transition
      actor.send({ type: "_agent:stop", timestamp: getConfigNow(normalizedConfig) });

      // Clean up event subscription
      eventSubscription.unsubscribe();

      // Stop the actor
      actor.stop();

      // Close the audio stream
      try {
        audioStreamController?.close();
      } catch {
        // Ignore if stream is already closed
      }
    },

    subscribe(callback: (state: AgentState) => void) {
      const subscription = actor.subscribe((snapshot) => {
        callback({
          value: snapshot.value,
          isRunning: isRunningState(snapshot.value),
          isSpeaking: snapshot.context.isSpeaking,
          messages: snapshot.context.messages,
          partialTranscript: snapshot.context.partialTranscript,
          status: snapshot.status,
          output: snapshot.output,
          metrics: computeAgentMetrics(snapshot.context.metrics, getConfigNow(normalizedConfig)),
        });
      });
      return () => subscription.unsubscribe();
    },

    getSnapshot(): AgentState {
      const snapshot = actor.getSnapshot();
      return {
        value: snapshot.value,
        isRunning: isRunningState(snapshot.value),
        isSpeaking: snapshot.context.isSpeaking,
        messages: snapshot.context.messages,
        partialTranscript: snapshot.context.partialTranscript,
        status: snapshot.status,
        output: snapshot.output,
        metrics: computeAgentMetrics(snapshot.context.metrics, getConfigNow(normalizedConfig)),
      };
    },
  };
}
