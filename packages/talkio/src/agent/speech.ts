/**
 * Speech pipeline for an AI turn.
 *
 * The TTS session synthesizes one item at a time, so sentences queue in
 * order. Audio can be held while an interruption is pending and released if
 * the interruption is cancelled. Every function here is pure.
 *
 * @module agent/speech
 */

import { nanoid } from "nanoid";

import type { TTSWordTiming } from "../providers/types";
import type { AITurn, HeldChunk, SpeechItem, SpeechSegment } from "./context";
import { createPlayback, type TimedSpeech } from "./playback";

/**
 * A speculative turn is prepared before the user's turn is confirmed: its
 * output is held and its public events are buffered until it commits.
 */
export function createAITurn(options: {
  now: number;
  tracksPlayback: boolean;
  speculative?: boolean;
  inputTranscript?: string;
  timelineStart?: number | null;
}): AITurn {
  const speculative = options.speculative ?? false;
  return {
    id: nanoid(),
    generationId: nanoid(),
    abortController: new AbortController(),
    speculative,
    inputTranscript: options.inputTranscript ?? "",
    pendingEvents: [],
    timelineStart: options.timelineStart ?? null,
    pendingThinks: [],
    generatedText: "",
    completedText: "",
    llmCompleted: false,
    queue: [],
    active: null,
    segments: [],
    outputHeld: speculative,
    holdNotified: false,
    held: [],
    audioDelivered: false,
    overlap: null,
    echoSuspected: false,
    playback: options.tracksPlayback ? createPlayback(options.now) : null,
    released: [],
    replayFromMs: null,
  };
}

export function enqueueSentence(ai: AITurn, text: string): AITurn {
  const item: SpeechItem = { requestId: nanoid(), text };
  return { ...ai, queue: [...ai.queue, item] };
}

/** Moves the next queued item to `active` if the TTS session is free. */
export function startNextSpeech(ai: AITurn): AITurn {
  if (ai.active !== null) return ai;
  const [next, ...rest] = ai.queue;
  if (!next) return ai;
  const segment: SpeechSegment = {
    ...next,
    deliveredBytes: 0,
    synthesized: false,
    startMs: null,
    durationMs: 0,
    words: [],
  };
  return { ...ai, active: next, queue: rest, segments: [...ai.segments, segment] };
}

function updateSegment(
  ai: AITurn,
  requestId: string,
  update: (segment: SpeechSegment) => SpeechSegment,
): SpeechSegment[] {
  return ai.segments.map((segment) =>
    segment.requestId === requestId ? update(segment) : segment,
  );
}

/** Records a synthesized chunk, either delivered to the listener or held. */
export function recordChunk(ai: AITurn, chunk: HeldChunk): AITurn {
  if (ai.outputHeld) {
    return { ...ai, held: [...ai.held, chunk] };
  }
  return {
    ...ai,
    audioDelivered: true,
    segments: updateSegment(ai, chunk.requestId, (segment) => ({
      ...segment,
      deliveredBytes: segment.deliveredBytes + chunk.audio.byteLength,
    })),
  };
}

/** Places released audio of `requestId` on the turn's audio timeline. */
export function placeOnTimeline(
  ai: AITurn,
  requestId: string,
  startMs: number,
  durationMs: number,
): AITurn {
  return {
    ...ai,
    segments: updateSegment(ai, requestId, (segment) => ({
      ...segment,
      startMs: segment.startMs ?? startMs,
      durationMs: segment.durationMs + durationMs,
    })),
  };
}

export function recordWordTimings(
  ai: AITurn,
  requestId: string,
  words: readonly TTSWordTiming[],
): AITurn {
  return {
    ...ai,
    segments: updateSegment(ai, requestId, (segment) => ({
      ...segment,
      words: [...segment.words, ...words],
    })),
  };
}

/** The turn's sentences on its audio timeline, for working out what was heard. */
export function timedSentences(ai: AITurn): TimedSpeech[] {
  return ai.segments;
}

export function finishActiveSpeech(ai: AITurn, synthesized: boolean): AITurn {
  if (!ai.active) return ai;
  const requestId = ai.active.requestId;
  return {
    ...ai,
    active: null,
    segments: synthesized
      ? updateSegment(ai, requestId, (segment) => ({ ...segment, synthesized: true }))
      : ai.segments,
  };
}

export function holdOutput(ai: AITurn): AITurn {
  return { ...ai, outputHeld: true, holdNotified: ai.audioDelivered };
}

export function isSpeechIdle(ai: AITurn): boolean {
  return ai.active === null && ai.queue.length === 0 && ai.held.length === 0;
}

export function generatedResponse(ai: AITurn): string {
  return ai.generatedText || ai.completedText;
}

function joinText(segments: SpeechSegment[]): string {
  return segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();
}

/**
 * Text whose audio started reaching the listener, and text whose audio was
 * fully synthesized and delivered.
 */
export function spokenText(ai: AITurn): { started: string; completed: string } {
  const sentences = ai.segments;
  const heldRequests = new Set(ai.held.map((chunk) => chunk.requestId));
  return {
    started: joinText(sentences.filter((segment) => segment.deliveredBytes > 0)),
    completed: joinText(
      sentences.filter(
        (segment) =>
          segment.synthesized && segment.deliveredBytes > 0 && !heldRequests.has(segment.requestId),
      ),
    ),
  };
}
