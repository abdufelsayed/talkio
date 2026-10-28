import { describe, expect, it } from "vitest";

import { splitAllSentences, splitSentences } from "../../src/agent/segmenter";
import { createTestAgent } from "../helpers/agent-harness";

describe("sentence splitting", () => {
  it("waits for whitespace after terminal punctuation", () => {
    expect(splitSentences("Hello there. How")).toEqual({
      sentences: ["Hello there."],
      rest: " How",
    });
    expect(splitSentences("Hello there.")).toEqual({ sentences: [], rest: "Hello there." });
  });

  it("does not split abbreviations, initials, decimals, or list numbers", () => {
    expect(splitAllSentences("Dr. Smith paid $3.50 at 5 p.m. today. Done.")).toEqual([
      "Dr. Smith paid $3.50 at 5 p.m. today.",
      "Done.",
    ]);
    expect(splitAllSentences("J. K. Rowling wrote it. Yes.")).toEqual([
      "J. K. Rowling wrote it.",
      "Yes.",
    ]);
    expect(splitAllSentences("1. Book a flight\n2. Pick a seat")).toEqual([
      "1. Book a flight",
      "2. Pick a seat",
    ]);
    expect(splitAllSentences("I have 3. Then I left.")).toEqual(["I have 3.", "Then I left."]);
  });

  it("keeps closing quotes and repeated punctuation with the sentence", () => {
    expect(splitAllSentences('She said "go!" Then left?! Fine…')).toEqual([
      'She said "go!"',
      "Then left?!",
      "Fine…",
    ]);
  });

  it("splits long text without a sentence end at its last clause break", () => {
    const clause = "this part keeps going without any full stop at all";
    const long = `${clause}, ${clause}, ${clause}, ${clause} and more`;
    const { sentences, rest } = splitSentences(long);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.endsWith(",")).toBe(true);
    expect(rest.trim().startsWith(clause)).toBe(true);
  });
});

function startTurn() {
  const harness = createTestAgent();
  harness.agent.start();
  harness.stt.emitTranscript("hello", true);
  return harness;
}

function spokenSentences(harness: ReturnType<typeof startTurn>): string[] {
  return harness.ofType("agent-turn:sentence").map((event) => event.sentence);
}

describe("automatic sentence splitting in the agent", () => {
  it("speaks a provider that only streams tokens", async () => {
    const harness = startTurn();
    harness.llm.emitToken("Hi there. ");
    harness.llm.emitToken("I can help");
    await Promise.resolve();
    expect(spokenSentences(harness)).toEqual(["Hi there."]);
    expect(harness.tts.getCurrentRequest()?.text).toBe("Hi there.");

    harness.llm.emitToken(" with that");
    harness.llm.complete("Hi there. I can help with that");
    expect(spokenSentences(harness)).toEqual(["Hi there.", "I can help with that"]);
    harness.agent.stop();
  });

  it("speaks a provider that only calls complete", () => {
    const harness = startTurn();
    harness.llm.complete("Sure. Your table is booked for eight.");
    expect(spokenSentences(harness)).toEqual(["Sure.", "Your table is booked for eight."]);
    harness.agent.stop();
  });

  it("uses provider sentences reported in the same tick without speaking twice", async () => {
    const harness = startTurn();
    harness.llm.emitToken("Hello. ");
    harness.llm.emitSentence("Hello.", 0);
    harness.llm.emitToken("Bye. ");
    harness.llm.emitSentence("Bye.", 1);
    await Promise.resolve();
    harness.llm.complete("Hello. Bye.");
    expect(spokenSentences(harness)).toEqual(["Hello.", "Bye."]);
    harness.agent.stop();
  });

  it("speaks the provider's version of a sentence reported in the same tick", async () => {
    const harness = startTurn();
    harness.llm.emitToken("Sure thing! ");
    harness.llm.emitSentence("Sure thing.", 0);
    await Promise.resolve();
    expect(spokenSentences(harness)).toEqual(["Sure thing."]);
    harness.agent.stop();
  });

  it("does not repeat text it split before the provider reported its own sentences", async () => {
    const harness = startTurn();
    harness.llm.emitToken("Here are the options:\n");
    await Promise.resolve();
    harness.llm.emitToken("one, two. ");
    harness.llm.emitSentence("Here are the options:\none, two.", 0);
    await Promise.resolve();
    expect(spokenSentences(harness)).toEqual(["Here are the options:", "one, two."]);
    harness.agent.stop();
  });
});
