/**
 * Classifies user speech that overlaps an AI turn.
 *
 * @module agent/overlap
 */

import type {
  InterruptionClassifierInput,
  InterruptionVerdict,
  ResolvedInterruptionConfig,
} from "../types/config";

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

/** Openings that mean the user wants the floor, even before a second word. */
const INTERRUPTION_CUES: readonly (readonly string[])[] = [
  "stop",
  "wait",
  "hold on",
  "hang on",
  "no",
  "nope",
  "sorry",
  "excuse me",
  "actually",
  "pause",
  "enough",
  "listen",
  "but",
].map((phrase) => phrase.split(" "));

const MAX_BACKCHANNEL_WORDS = 4;

/** Agent words compared against a transcript when checking for echo. */
const ECHO_WINDOW_WORDS = 40;
const ECHO_MIN_WORDS = 2;
const ECHO_MATCH_RATIO = 0.7;

export function transcriptWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

function phraseAt(
  words: readonly string[],
  index: number,
  phrases: readonly (readonly string[])[],
): number {
  return phrases
    .filter((phrase) => phrase.every((word, offset) => words[index + offset] === word))
    .reduce((longest, phrase) => Math.max(longest, phrase.length), 0);
}

/** True when the transcript consists only of acknowledgement words and phrases. */
export function isBackchannel(text: string): boolean {
  const words = transcriptWords(text);
  if (words.length === 0 || words.length > MAX_BACKCHANNEL_WORDS) return false;
  let index = 0;
  while (index < words.length) {
    const length = phraseAt(words, index, BACKCHANNEL_PHRASES);
    if (length === 0) return false;
    index += length;
  }
  return true;
}

export function startsWithInterruptionCue(text: string): boolean {
  return phraseAt(transcriptWords(text), 0, INTERRUPTION_CUES) > 0;
}

/**
 * True when the transcript is mostly the agent's own recent words, in order:
 * the microphone picked up the agent's voice.
 */
export function isEcho(transcript: string, agentText: string, minWords = ECHO_MIN_WORDS): boolean {
  const heard = transcriptWords(transcript);
  if (heard.length < minWords) return false;
  const spoken = transcriptWords(agentText).slice(-ECHO_WINDOW_WORDS);
  let matched = 0;
  let cursor = 0;
  for (const word of heard) {
    const found = spoken.indexOf(word, cursor);
    if (found === -1) continue;
    matched++;
    cursor = found + 1;
  }
  return matched >= minWords && matched / heard.length >= ECHO_MATCH_RATIO;
}

/**
 * After a reply, users often answer with words from it ("two people?"), so
 * only a long run of the reply's words counts as its echo there.
 */
const REPLY_ECHO_MIN_WORDS = 4;

/**
 * Whether a transcript only repeats what the agent just made audible. Users
 * do not answer a backchannel by repeating it, so a backchannel also matches
 * a phrase too short for `isEcho`, such as "Okay.", when it is the whole
 * transcript.
 */
export function repeatsAgentSpeech(
  transcript: string,
  speech: { text: string; source: "backchannel" | "reply" },
): boolean {
  if (speech.source === "reply") return isEcho(transcript, speech.text, REPLY_ECHO_MIN_WORDS);
  if (isEcho(transcript, speech.text)) return true;
  const heard = transcriptWords(transcript).join(" ");
  return heard !== "" && heard === transcriptWords(speech.text).join(" ");
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

/**
 * The built-in interruption classifier: the agent's own echo and
 * acknowledgements never interrupt; interruption cues, final transcripts,
 * and interim transcripts with enough words do.
 */
export function classifyInterruption(
  input: InterruptionClassifierInput,
  config: Pick<ResolvedInterruptionConfig, "interimMinWords" | "interimMinChars">,
): InterruptionVerdict {
  if (transcriptWords(input.transcript).length === 0) return "undecided";
  if (isEcho(input.transcript, input.agentText)) return "echo";
  if (isBackchannel(input.transcript)) return "backchannel";
  if (startsWithInterruptionCue(input.transcript) || input.isFinal) return "interrupt";
  if (isMeaningfulTranscript(input.transcript, config)) return "interrupt";
  return "undecided";
}
