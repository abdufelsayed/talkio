/**
 * Splits streamed LLM text into speakable sentences for TTS.
 *
 * A sentence ends at terminal punctuation followed by whitespace, or at a
 * line break, unless the period belongs to an abbreviation, an initial, or a
 * list number. Text that runs long without a sentence end is split at its
 * last clause break so the first audio is not held back by one long sentence.
 *
 * @module agent/segmenter
 */

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "inc",
  "ltd",
  "co",
  "corp",
  "no",
  "approx",
  "dept",
  "est",
  "fig",
  "mt",
  "u.s",
  "a.m",
  "p.m",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
]);

/** Longest text spoken as one piece before it is split at a clause break. */
const MAX_SENTENCE_LENGTH = 200;

const TERMINAL = /[.!?…]/;
const CLOSING = /["'”’)\]]/;
const CLAUSE_BREAK = /[,;:—–]\s/g;

function endsSentenceAt(text: string, index: number): boolean {
  if (text[index] !== ".") return true;
  const before = text.slice(0, index);
  const word = (/(\S+)$/.exec(before)?.[1] ?? "").toLowerCase().replace(/^["'(“‘]+/, "");
  if (ABBREVIATIONS.has(word)) return false;
  if (/^\p{L}$/u.test(word)) return false;
  if (/^\d+$/.test(word) && (before.length === word.length || /\n\s*\d+$/.test(before))) {
    return false;
  }
  return true;
}

export function splitSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index++) {
    const char = buffer[index] ?? "";
    if (char === "\n") {
      const sentence = buffer.slice(start, index).trim();
      if (sentence) sentences.push(sentence);
      start = index + 1;
      continue;
    }
    if (!TERMINAL.test(char)) continue;

    let end = index + 1;
    while (
      end < buffer.length &&
      (TERMINAL.test(buffer[end] ?? "") || CLOSING.test(buffer[end] ?? ""))
    ) {
      end++;
    }
    if (end >= buffer.length || !/\s/.test(buffer[end] ?? "")) continue;
    if (!endsSentenceAt(buffer, index)) continue;

    const sentence = buffer.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    index = end - 1;
  }

  let rest = buffer.slice(start);
  if (rest.trim().length > MAX_SENTENCE_LENGTH) {
    const breaks = [...rest.matchAll(CLAUSE_BREAK)];
    const last = breaks.at(-1);
    const cut = last?.index !== undefined ? last.index + 1 : rest.lastIndexOf(" ");
    if (cut > 0) {
      sentences.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
  }

  return { sentences, rest };
}

/** Splits complete text; the trailing remainder is a sentence too. */
export function splitAllSentences(text: string): string[] {
  const { sentences, rest } = splitSentences(text);
  return rest.trim() ? [...sentences, rest.trim()] : sentences;
}
