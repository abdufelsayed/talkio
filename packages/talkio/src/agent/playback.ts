/**
 * Estimates how much of an AI turn's audio the listener has heard.
 *
 * Audio released to the listener is assumed to play in real time as soon as
 * it arrives, stalling when the listener's buffer runs dry and freezing while
 * playback is paused. Reports from the client replace the estimate.
 *
 * Positions are milliseconds on the turn's audio timeline: the concatenation
 * of every chunk released for the turn, in order.
 *
 * @module agent/playback
 */

import type { TTSWordTiming } from "../providers/types";

export interface PlaybackState {
  /** End of the audio released to the listener so far. */
  releasedMs: number;
  /** Estimated playhead at time `at`. */
  position: number;
  at: number;
  playing: boolean;
}

/** A sentence placed on the turn's audio timeline. */
export interface TimedSpeech {
  text: string;
  startMs: number | null;
  durationMs: number;
  synthesized: boolean;
  words: readonly TTSWordTiming[];
}

/** Below a millisecond of unplayed audio, the turn counts as fully heard. */
export const PLAYOUT_EPSILON_MS = 1;

/** Typical conversational speech rate, used when TTS reports no word timings. */
const ESTIMATED_MS_PER_WORD = 380;

export function createPlayback(now: number): PlaybackState {
  return { releasedMs: 0, position: 0, at: now, playing: false };
}

export function playbackPosition(playback: PlaybackState, now: number): number {
  if (!playback.playing) return playback.position;
  const elapsed = Math.max(0, now - playback.at);
  return Math.min(playback.releasedMs, playback.position + elapsed);
}

export function remainingPlayoutMs(playback: PlaybackState, now: number): number {
  return Math.max(0, playback.releasedMs - playbackPosition(playback, now));
}

/**
 * Adds released audio. Playback starts, or restarts after the listener's
 * buffer ran dry, once the audio has crossed `latencyMs` of transport.
 */
export function releaseAudio(
  playback: PlaybackState,
  now: number,
  durationMs: number,
  latencyMs: number,
): PlaybackState {
  const releasedMs = playback.releasedMs + durationMs;
  const position = playbackPosition(playback, now);
  if (playback.playing && position < playback.releasedMs) {
    return { ...playback, releasedMs };
  }
  return { releasedMs, position, at: now + latencyMs, playing: true };
}

/** Freezes the playhead, for paused playback and for a listener that dropped its buffer. */
export function pausePlayback(playback: PlaybackState, now: number): PlaybackState {
  return { ...playback, position: playbackPosition(playback, now), at: now, playing: false };
}

export function resumePlayback(playback: PlaybackState, now: number): PlaybackState {
  return { ...playback, at: now, playing: playback.releasedMs > playback.position };
}

export function reportPlayback(
  playback: PlaybackState,
  now: number,
  playedMs: number,
): PlaybackState {
  const position = Math.min(playback.releasedMs, Math.max(0, playedMs));
  return { ...playback, position, at: now };
}

function spokenWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * Text the listener heard up to `position`. Sentences heard to the end count
 * in full; the sentence playing at `position` is cut at its last finished
 * word, from TTS word timings or, without them, an even speech rate.
 */
export function heardText(speech: readonly TimedSpeech[], position: number): string {
  const heard: string[] = [];
  for (const segment of speech) {
    if (segment.startMs === null) continue;
    const offset = position - segment.startMs;
    if (segment.synthesized && offset >= segment.durationMs - PLAYOUT_EPSILON_MS) {
      heard.push(segment.text);
      continue;
    }
    if (offset <= 0) continue;

    const words = spokenWords(segment.text);
    let finished: number;
    if (segment.words.length > 0) {
      finished = segment.words.filter((word) => word.endMs <= offset).length;
    } else {
      const totalMs = segment.synthesized
        ? segment.durationMs
        : Math.max(segment.durationMs, words.length * ESTIMATED_MS_PER_WORD);
      finished = totalMs > 0 ? Math.floor(words.length * Math.min(1, offset / totalMs)) : 0;
    }
    heard.push(words.slice(0, finished).join(" "));
  }
  return heard.filter(Boolean).join(" ").trim();
}
