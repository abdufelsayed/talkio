/**
 * Speech pipeline for an AI turn.
 *
 * The TTS session synthesizes one item at a time. Sentences queue in order;
 * fillers jump the queue because they only make sense before the answer.
 * Audio can be held while an interruption is pending and released if the
 * interruption is cancelled. Every function here is pure.
 *
 * @module agent/speech
 */

import { nanoid } from "nanoid";

import type { TTSWordTiming } from "../providers/types";
import type { AITurn, Commitment, HeldChunk, SpeechItem, SpeechSegment } from "./context";
import { createPlayback, type TimedSpeech } from "./playback";

export function createCommitment(): Commitment {
  let resolve: ((committed: boolean) => void) | undefined;
  let settled = false;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  return {
    promise,
    settle: (committed) => {
      if (settled) return;
      settled = true;
      resolve?.(committed);
    },
  };
}

/**
 * A speculative turn is prepared before the user's turn is confirmed: its
 * output is held and its public events are buffered until it commits.
 */
export function createAITurn(options: {
  now: number;
  tracksPlayback: boolean;
  speculative?: boolean;
  inputTranscript?: string;
}): AITurn {
  const speculative = options.speculative ?? false;
  const commitment = createCommitment();
  if (!speculative) commitment.settle(true);
  return {
    id: nanoid(),
    generationId: nanoid(),
    abortController: new AbortController(),
    speculative,
    inputTranscript: options.inputTranscript ?? "",
    pendingEvents: [],
    commitment,
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
    playback: options.tracksPlayback ? createPlayback(options.now) : null,
    released: [],
    replayFromMs: null,
  };
}

export function enqueueSentence(ai: AITurn, text: string): AITurn {
  const item: SpeechItem = { requestId: nanoid(), kind: "sentence", text };
  return { ...ai, queue: [...ai.queue, item] };
}

export function enqueueFiller(ai: AITurn, text: string): AITurn {
  const item: SpeechItem = { requestId: nanoid(), kind: "filler", text };
  const fillers = ai.queue.filter((queued) => queued.kind === "filler");
  const sentences = ai.queue.filter((queued) => queued.kind === "sentence");
  return { ...ai, queue: [...fillers, item, ...sentences] };
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
  return ai.segments.filter((segment) => segment.kind === "sentence");
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

/** Removes queued fillers; reports whether the active item is a filler to clear. */
export function dropFillers(ai: AITurn): { ai: AITurn; activeFillerCleared: boolean } {
  const activeFillerCleared = ai.active?.kind === "filler";
  return {
    ai: {
      ...ai,
      active: activeFillerCleared ? null : ai.active,
      queue: ai.queue.filter((item) => item.kind !== "filler"),
    },
    activeFillerCleared,
  };
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
 * fully synthesized and delivered. Fillers are not part of the response.
 */
export function spokenText(ai: AITurn): { started: string; completed: string } {
  const sentences = ai.segments.filter((segment) => segment.kind === "sentence");
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
