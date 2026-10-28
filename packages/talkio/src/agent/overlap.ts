/**
 * Classifies user speech that overlaps an AI turn.
 *
 * @module agent/overlap
 */

import type { ResolvedInterruptionConfig } from "../types/config";

/**
 * - `interrupt`: the user wants the floor.
 * - `backchannel`: the user is only acknowledging the agent.
 * - `undecided`: not enough words yet.
 */
export type OverlapVerdict = "interrupt" | "backchannel" | "undecided";

const BACKCHANNEL_PHRASES: readonly (readonly string[])[] = [
  "yeah",
  "yea",
  "ya",
  "yes",
  "yep",
  "yup",
  "mhm",
  "mmhmm",
  "mhmm",
  "uhhuh",
  "hmm",
  "hm",
  "mm",
  "mmm",
  "uh",
  "um",
  "ok",
  "okay",
  "kay",
  "right",
  "sure",
  "alright",
  "cool",
  "nice",
  "great",
  "wow",
  "oh",
  "ah",
  "aha",
  "gotcha",
  "exactly",
  "totally",
  "true",
  "indeed",
  "uh huh",
  "mm hmm",
  "i see",
  "got it",
  "all right",
  "for sure",
  "of course",
  "makes sense",
  "that makes sense",
  "that's right",
  "thats right",
  "sounds good",
].map((phrase) => phrase.split(" "));

const MAX_BACKCHANNEL_WORDS = 4;

export function transcriptWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/** True when the transcript consists only of acknowledgement words and phrases. */
export function isBackchannel(text: string): boolean {
  const words = transcriptWords(text);
  if (words.length === 0 || words.length > MAX_BACKCHANNEL_WORDS) return false;

  let index = 0;
  while (index < words.length) {
    const match = BACKCHANNEL_PHRASES.filter((phrase) =>
      phrase.every((word, offset) => words[index + offset] === word),
    ).reduce((longest, phrase) => Math.max(longest, phrase.length), 0);
    if (match === 0) return false;
    index += match;
  }
  return true;
}

export function isMeaningfulTranscript(
  text: string,
  config: Pick<ResolvedInterruptionConfig, "interimMinWords" | "interimMinChars">,
): boolean {
  const trimmed = text.trim();
  return (
    trimmed.replace(/\s+/g, "").length >= config.interimMinChars &&
    transcriptWords(trimmed).length >= config.interimMinWords
  );
}

export function classifyOverlapTranscript(
  text: string,
  isFinal: boolean,
  config: ResolvedInterruptionConfig,
): OverlapVerdict {
  if (!text.trim()) return "undecided";
  if (isBackchannel(text)) return "backchannel";
  if (isFinal || isMeaningfulTranscript(text, config)) return "interrupt";
  return "undecided";
}
