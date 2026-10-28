import { describe, expect, it } from "vitest";

import type { BackchannelConfig } from "../../src/types/config";
import { audioChunk, createTestAgent, type TestAgent } from "../helpers/agent-harness";

function createListeningAgent(backchannels: BackchannelConfig = {}, maxDelayMs = 2500) {
  const harness = createTestAgent({
    vad: true,
    turnDetector: "probability",
    turnTaking: { minDelayMs: 400, maxDelayMs, threshold: 0.7 },
    backchannels,
  });
  harness.agent.start();
  return harness;
}

/** The user talks at length and pauses mid-thought, and the agent starts a backchannel. */
function startBackchannel(harness: TestAgent, text: string) {
  harness.vad?.emitSpeechStart();
  harness.stt.emitTranscript(text, true);
  harness.clock.increment(4500);
  harness.vad?.emitSpeechEnd(4500);
  harness.turnDetector?.emitProbability(0.1);
  harness.clock.increment(400);
}

function backchannel(harness: TestAgent, text: string, audio = audioChunk(1)) {
  startBackchannel(harness, text);
  harness.tts.emitAudio(audio);
  harness.tts.complete();
}

function transcripts(harness: TestAgent) {
  return harness.ofType("user-turn:transcript").map((event) => event.text);
}

describe("hearing itself without echo cancellation", () => {
  it("keeps its backchannel out of what the user said", () => {
    const harness = createListeningAgent();
    backchannel(harness, "so first I went to the station");
    harness.stt.emitTranscript("Mm-hmm.", true);

    harness.turnDetector?.emitProbability(0.95);
    expect(harness.ofType("user-turn:ended")).toMatchObject([
      { text: "so first I went to the station" },
    ]);
    expect(transcripts(harness)).toEqual(["so first I went to the station"]);
    expect(harness.turnDetector?.receivedTranscripts.map((entry) => entry.text)).toEqual([
      "so first I went to the station",
    ]);
    harness.agent.stop();
  });

  it("recognizes the echo while the backchannel is still being synthesized", () => {
    const harness = createListeningAgent();
    startBackchannel(harness, "so first I went to the station");
    harness.tts.emitAudio(audioChunk(1));
    harness.stt.emitTranscript("Mm-hmm.", true);
    expect(transcripts(harness)).toEqual(["so first I went to the station"]);
    harness.agent.stop();
  });

  it("waits for a long backchannel to finish playing before the echo window closes", () => {
    // A long end-of-turn wait keeps the user's turn open while the echo arrives.
    const harness = createListeningAgent({ phrases: ["Okay, go on."] }, 5000);
    // One second of 24 kHz linear16 audio.
    backchannel(harness, "so first I went to the station", new ArrayBuffer(48_000));
    harness.clock.increment(2400);
    harness.stt.emitTranscript("okay go on", true);
    expect(transcripts(harness)).toEqual(["so first I went to the station"]);
    harness.agent.stop();
  });

  it("matches a one-word backchannel only as a whole, and only for a moment", () => {
    const harness = createListeningAgent({ phrases: ["Okay."] });
    backchannel(harness, "so first I went to the station");
    harness.stt.emitTranscript("Okay.", true);
    harness.stt.emitTranscript("okay and then", false);
    expect(transcripts(harness)).toEqual(["so first I went to the station", "okay and then"]);

    harness.clock.increment(1501);
    harness.stt.emitTranscript("Okay.", true);
    expect(transcripts(harness).at(-1)).toBe("Okay.");
    harness.agent.stop();
  });

  it("does not answer the tail of its own reply", () => {
    const harness = createTestAgent();
    harness.agent.start();
    harness.stt.emitTranscript("when does it ship", true);
    harness.llm.emitSentence("Your order ships on Monday.", 0);
    harness.tts.emitAudio(audioChunk(1));
    harness.tts.complete();
    harness.llm.complete("Your order ships on Monday.");
    expect(harness.ofType("agent-turn:ended")).toHaveLength(1);

    harness.clock.increment(500);
    harness.stt.emitTranscript("your order ships on Monday", true);
    expect(harness.ofType("user-turn:started")).toHaveLength(1);
    expect(harness.llm.generations).toBe(1);

    harness.clock.increment(1001);
    harness.stt.emitTranscript("your order ships on Monday", true);
    expect(harness.ofType("user-turn:started")).toHaveLength(2);
    expect(harness.llm.generations).toBe(2);
    harness.agent.stop();
  });

  it.each([
    { reply: "Is that for two people?", answer: "two people" },
    { reply: "life-6 response.", answer: "life-6" },
  ])("hears an answer that repeats a few of its words: $answer", ({ reply, answer }) => {
    const harness = createTestAgent();
    harness.agent.start();
    harness.stt.emitTranscript("a table please", true);
    harness.llm.emitSentence(reply, 0);
    harness.tts.emitAudio(audioChunk(1));
    harness.tts.complete();
    harness.llm.complete(reply);

    harness.stt.emitTranscript(answer, true);
    expect(harness.ofType("user-turn:ended").at(-1)).toMatchObject({ text: answer });
    expect(harness.llm.generations).toBe(2);
    harness.agent.stop();
  });

  it("keeps the echo of an interrupted reply out of the interruption", () => {
    const harness = createTestAgent({ vad: true });
    harness.agent.start();
    harness.stt.emitTranscript("when does it ship", true);
    harness.llm.emitSentence("Your order ships on Monday.", 0);
    // One second of 24 kHz linear16 audio, fully played before the user cuts in.
    harness.tts.emitAudio(new ArrayBuffer(48_000));
    harness.tts.complete();
    harness.clock.increment(1000);

    harness.vad?.emitSpeechStart();
    harness.stt.emitTranscript("wait stop", false);
    expect(harness.ofType("agent-turn:interrupted")).toHaveLength(1);
    harness.stt.emitTranscript("your order ships on Monday", true);
    harness.stt.emitTranscript("wait stop that", true);

    expect(harness.ofType("user-turn:abandoned")).toHaveLength(0);
    expect(harness.ofType("user-turn:ended").map((event) => event.text)).toEqual([
      "when does it ship",
      "wait stop that",
    ]);
    harness.agent.stop();
  });

  it("abandons a turn a turn detector ends on the agent's own words", () => {
    const harness = createTestAgent({ turnDetector: "decision" });
    harness.agent.start();
    harness.turnDetector?.emitEnd("when does it ship");
    harness.llm.emitSentence("Your order ships on Monday.", 0);
    harness.tts.emitAudio(audioChunk(1));
    harness.tts.complete();
    harness.llm.complete("Your order ships on Monday.");

    harness.turnDetector?.emitEnd("your order ships on Monday");
    expect(harness.ofType("user-turn:abandoned")).toMatchObject([{ reason: "echo" }]);
    expect(harness.llm.generations).toBe(1);
    harness.agent.stop();
  });
});
