/**
 * Agent Machine Context
 *
 * State the agent machine keeps between events. Turn-specific state lives in
 * `human` and `ai`, which exist only while that party's turn is open, so a
 * finished turn cannot leak flags into the next one.
 *
 * @module agent/context
 */

import type { TTSWordTiming } from "../providers/types";
import type { Message } from "../types/common";
import type { InterruptionVerdict, NormalizedAgentConfig } from "../types/config";
import type { PublicAgentEvent, VoiceSource } from "../types/events";
import { createInitialMetricsState, type MetricsTrackingState } from "../types/metrics";
import type { AudioOutputBuffer } from "./audio-output";
import type { PlaybackState } from "./playback";

/**
 * What ends the user's turn:
 * - `stt`: the STT provider's final transcripts.
 * - `decision`: explicit turn signals from a turn detector, or from an STT
 *   provider with native turn detection; final transcripts only accumulate.
 * - `prediction`: the agent, after a silence scaled by the detector's
 *   end-of-turn probability.
 */
export type TurnSource = "stt" | "decision" | "prediction";

export type SpeechKind = "sentence" | "filler";

export interface SpeechItem {
  requestId: string;
  kind: SpeechKind;
  text: string;
}

/** A speech item that was sent to TTS, with what became of its audio. */
export interface SpeechSegment extends SpeechItem {
  deliveredBytes: number;
  synthesized: boolean;
  /** Where the segment's first released audio sits on the turn's audio timeline. */
  startMs: number | null;
  durationMs: number;
  words: TTSWordTiming[];
}

/** Released audio kept so a listener that dropped its buffer can be replayed. */
export interface ReleasedChunk extends HeldChunk {
  startMs: number;
  durationMs: number;
}

export interface HeldChunk {
  requestId: string;
  audio: ArrayBuffer;
}

/** User speech that overlaps an AI turn and may become an interruption. */
export interface Overlap {
  startedAt: number;
  transcript: string;
  /** The latest decisive verdict on this speech; undecided verdicts do not replace it. */
  verdict: InterruptionVerdict | null;
}

export interface HumanTurn {
  id: string;
  startedAt: number;
  finalText: string;
  interimText: string;
  speechMs: number;
  /** When the user last stopped speaking, or last produced a transcript without voice events. */
  quietSince: number | null;
  endOfTurnProbability: number | null;
}

/** Settles once: `true` when a turn commits, `false` when it is discarded. */
export interface Commitment {
  promise: Promise<boolean>;
  settle: (committed: boolean) => void;
}

export interface AITurn {
  id: string;
  generationId: string;
  abortController: AbortController;
  /** Generated before the user's turn was confirmed; nothing is public until it commits. */
  speculative: boolean;
  /** The user transcript a speculative turn was prepared for. */
  inputTranscript: string;
  /** Public events held back while speculative, replayed in order on commit. */
  pendingEvents: PublicAgentEvent[];
  commitment: Commitment;
  generatedText: string;
  completedText: string;
  llmCompleted: boolean;
  queue: SpeechItem[];
  active: SpeechItem | null;
  segments: SpeechSegment[];
  outputHeld: boolean;
  /** Whether a pause/clear event told the listener to stop when output was held. */
  holdNotified: boolean;
  held: HeldChunk[];
  audioDelivered: boolean;
  overlap: Overlap | null;
  /**
   * The microphone picked up the agent's own voice this turn, so voice
   * activity alone no longer pauses it; only words that interrupt do.
   */
  echoSuspected: boolean;
  /** What the listener has heard; null when the output format has no fixed byte rate. */
  playback: PlaybackState | null;
  /** Released audio, retained only in `pendingAudio: "clear"` mode for replay. */
  released: ReleasedChunk[];
  /** Timeline position to replay from after the listener dropped its buffer. */
  replayFromMs: number | null;
}

export interface AgentMachineContext {
  config: NormalizedAgentConfig;
  voiceSource: VoiceSource;
  turnSource: TurnSource;
  sessionAbortController: AbortController;
  audioOutput: AudioOutputBuffer;
  messages: Message[];
  /** True until the agent says something audible after the latest user message. */
  userAwaitingAnswer: boolean;
  /** User turns committed while the agent could not be interrupted; answered next. */
  queuedUserTranscripts: string[];
  partialTranscript: string;
  isSpeaking: boolean;
  voice: { active: boolean; startedAt: number | null };
  human: HumanTurn | null;
  ai: AITurn | null;
  metrics: MetricsTrackingState;
}

function resolveTurnSource(config: NormalizedAgentConfig): TurnSource {
  if (config.turnDetector) {
    return config.turnDetector.metadata.mode === "prediction" ? "prediction" : "decision";
  }
  return config.stt.metadata.turnDetection ? "decision" : "stt";
}

export function createInitialContext(
  config: NormalizedAgentConfig,
  audioOutput: AudioOutputBuffer,
): AgentMachineContext {
  return {
    config,
    voiceSource: config.vad ? "vad" : "stt",
    turnSource: resolveTurnSource(config),
    sessionAbortController: new AbortController(),
    audioOutput,
    messages: [],
    userAwaitingAnswer: false,
    queuedUserTranscripts: [],
    partialTranscript: "",
    isSpeaking: false,
    voice: { active: false, startedAt: null },
    human: null,
    ai: null,
    metrics: createInitialMetricsState(),
  };
}
