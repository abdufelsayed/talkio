import { describe, expect, it } from "vitest";

import type { AgentConfig, FillerConfig } from "../../src/types/config";
import { audioChunk, bytesOf, createTestAgent, type TestAgent } from "../helpers/agent-harness";

function createFillerAgent(fillers: FillerConfig = {}) {
  const harness = createTestAgent({ vad: true, fillers });
  harness.agent.start();
  return harness;
}

function createListeningAgent(
  backchannels: AgentConfig["backchannels"] = true,
  fillers?: AgentConfig["fillers"],
) {
  const harness = createTestAgent({
    vad: true,
    turnDetector: "probability",
    turnTaking: { minDelayMs: 400, maxDelayMs: 2500, threshold: 0.7 },
    backchannels,
    fillers,
  });
  harness.agent.start();
  return harness;
}

/** The user speaks for `ms`, then pauses with the given end-of-turn probability. */
function talk(harness: TestAgent, ms: number, text: string, endOfTurnProbability: number) {
  harness.vad?.emitSpeechStart();
  harness.stt.emitTranscript(text, true);
  harness.clock.increment(ms);
  harness.vad?.emitSpeechEnd(ms);
  harness.turnDetector?.emitProbability(endOfTurnProbability);
}

function finishSpeech(harness: TestAgent, ...bytes: number[]) {
  harness.tts.emitAudio(audioChunk(...bytes));
  harness.tts.complete();
}

describe("thinking fillers", () => {
  it("says a filler when the reply is slow to start and keeps it out of the reply", () => {
    const harness = createFillerAgent();
    harness.stt.emitTranscript("book me a flight to Paris", true);
    harness.clock.increment(1199);
    expect(harness.tts.requestedTexts).toEqual([]);

    harness.clock.increment(1);
    expect(harness.tts.requestedTexts).toEqual(["One moment."]);
    harness.llm.emitSentence("You are booked.", 0);
    finishSpeech(harness, 1);
    expect(harness.tts.requestedTexts).toEqual(["One moment.", "You are booked."]);
    finishSpeech(harness, 2);
    harness.llm.complete("You are booked.");

    expect(harness.ofType("agent-turn:sentence").map((event) => event.sentence)).toEqual([
      "You are booked.",
    ]);
    expect(harness.ofType("agent-turn:ended")).toMatchObject([{ text: "You are booked." }]);
    expect(harness.agent.getSnapshot().messages.at(-1)).toEqual({
      role: "assistant",
      content: "You are booked.",
    });
    harness.agent.stop();
  });

  it("leaves the filler out of what the user heard of an interrupted reply", () => {
    const harness = createFillerAgent();
    harness.stt.emitTranscript("book me a flight to Paris", true);
    harness.clock.increment(1200);
    // 100ms of 24kHz 16-bit mono audio, fully played before the user cuts in.
    harness.tts.emitAudio(new ArrayBuffer(4800));
    harness.tts.complete();
    harness.clock.increment(200);

    harness.vad?.emitSpeechStart();
    harness.stt.emitTranscript("actually never mind", false);
    expect(harness.ofType("agent-turn:interrupted")).toMatchObject([
      { generatedText: "", heardText: "" },
    ]);
    harness.agent.stop();
  });

  it("stays quiet once the reply has started", () => {
    const harness = createFillerAgent();
    harness.stt.emitTranscript("hello", true);
    harness.clock.increment(500);
    harness.llm.emitSentence("Hi.", 0);
    harness.clock.increment(2000);
    finishSpeech(harness, 1);
    harness.llm.complete("Hi.");

    expect(harness.tts.requestedTexts).toEqual(["Hi."]);
    expect(harness.ofType("agent-turn:ended")).toHaveLength(1);
    harness.agent.stop();
  });

  it("starts the wait over when the user talks during it", () => {
    const harness = createFillerAgent();
    harness.stt.emitTranscript("book me a flight to Paris", true);
    harness.clock.increment(1000);
    harness.vad?.emitSpeechStart();
    harness.clock.increment(500);
    harness.vad?.emitSpeechEnd(500);
    expect(harness.tts.requestedTexts).toEqual([]);

    harness.clock.increment(600);
    expect(harness.ofType("agent-turn:interruption-cancelled")).toHaveLength(1);
    harness.clock.increment(1199);
    expect(harness.tts.requestedTexts).toEqual([]);
    harness.clock.increment(1);
    expect(harness.tts.requestedTexts).toEqual(["One moment."]);
    harness.agent.stop();
  });

  it("does not jump ahead of a reply waiting for a backchannel to finish", () => {
    const harness = createListeningAgent({}, {});
    talk(harness, 4500, "I keep getting an error when I log in", 0.1);
    harness.clock.increment(400);
    harness.turnDetector?.emitProbability(0.95);
    harness.llm.emitSentence("Let's reset your password.", 0);
    harness.clock.increment(1200);

    finishSpeech(harness, 1);
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm.", "Let's reset your password."]);
    harness.agent.stop();
  });

  it("rotates through its phrases after the configured wait", () => {
    const harness = createFillerAgent({
      afterMs: 100,
      phrases: ["First filler.", "Second filler."],
    });
    for (const question of ["one", "two"]) {
      harness.stt.emitTranscript(question, true);
      harness.clock.increment(100);
      finishSpeech(harness, 1);
      harness.llm.emitSentence("Answer.", 0);
      finishSpeech(harness, 2);
      harness.llm.complete("Answer.");
    }

    expect(harness.tts.requestedTexts).toEqual([
      "First filler.",
      "Answer.",
      "Second filler.",
      "Answer.",
    ]);
    harness.agent.stop();
  });

  it.each([undefined, false])("is off by default and with false: %s", (fillers) => {
    const harness = createTestAgent({ fillers });
    harness.agent.start();
    harness.stt.emitTranscript("hello", true);
    harness.clock.increment(10_000);
    expect(harness.tts.requestedTexts).toEqual([]);
    harness.agent.stop();
  });
});

describe("agent backchannels", () => {
  it("acknowledges a long turn at a mid-thought pause without ending it", async () => {
    const harness = createListeningAgent();
    talk(harness, 4500, "so first I went to the station and then", 0.1);
    harness.clock.increment(399);
    expect(harness.ofType("agent:backchannel")).toHaveLength(0);

    harness.clock.increment(1);
    const [backchannel] = harness.ofType("agent:backchannel");
    expect(backchannel?.text).toBe("Mm-hmm.");
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm."]);
    harness.tts.emitAudio(audioChunk(5));
    expect(harness.ofType("agent-turn:audio")).toMatchObject([{ turnId: backchannel?.turnId }]);
    const chunk = await harness.agent.audioStream.getReader().read();
    expect(bytesOf(chunk.value)).toEqual([5]);

    expect(harness.ofType("user-turn:ended")).toHaveLength(0);
    expect(harness.ofType("agent-turn:started")).toHaveLength(0);
    harness.agent.stop();
  });

  it.each([
    { probability: 0.3, backchannels: 1 },
    { probability: 0.4, backchannels: 0 },
  ])(
    "treats a pause with end-of-turn probability $probability accordingly",
    ({ probability, backchannels }) => {
      const harness = createListeningAgent();
      talk(harness, 4500, "and that is about it", probability);
      harness.clock.increment(400);
      expect(harness.ofType("agent:backchannel")).toHaveLength(backchannels);
      expect(harness.llm.generations).toBe(0);
      harness.agent.stop();
    },
  );

  it("needs enough speech before each acknowledgement", () => {
    const harness = createListeningAgent({ minSpeechMs: 3000 });
    talk(harness, 1500, "well", 0.1);
    harness.clock.increment(500);
    expect(harness.ofType("agent:backchannel")).toHaveLength(0);

    talk(harness, 2000, "it started last week", 0.1);
    harness.clock.increment(400);
    expect(harness.ofType("agent:backchannel")).toHaveLength(1);
    finishSpeech(harness, 1);

    talk(harness, 1000, "and then", 0.1);
    harness.clock.increment(400);
    expect(harness.ofType("agent:backchannel")).toHaveLength(1);

    talk(harness, 2000, "it happened again", 0.1);
    harness.clock.increment(400);
    expect(harness.ofType("agent:backchannel").map((event) => event.text)).toEqual([
      "Mm-hmm.",
      "Uh-huh.",
    ]);
    harness.agent.stop();
  });

  it("holds the reply until a backchannel finishes", () => {
    const harness = createListeningAgent();
    talk(harness, 4500, "I keep getting an error when I log in", 0.1);
    harness.clock.increment(400);
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm."]);

    harness.turnDetector?.emitProbability(0.95);
    expect(harness.ofType("agent-turn:started")).toHaveLength(1);
    harness.llm.emitSentence("Let's reset your password.", 0);
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm."]);

    finishSpeech(harness, 1);
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm.", "Let's reset your password."]);
    harness.agent.stop();
  });

  it("reports a backchannel that fails to synthesize and carries on", () => {
    const harness = createListeningAgent();
    talk(harness, 4500, "I keep getting an error when I log in", 0.1);
    harness.clock.increment(400);
    harness.turnDetector?.emitProbability(0.95);
    harness.llm.emitSentence("Let's reset your password.", 0);

    harness.tts.error(new Error("synthesis failed"));
    expect(harness.ofType("agent:error")).toMatchObject([{ source: "tts" }]);
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm.", "Let's reset your password."]);
    harness.agent.stop();
  });

  it("counts the pause from when the user stopped, not from the prediction", () => {
    const harness = createListeningAgent();
    harness.vad?.emitSpeechStart();
    harness.stt.emitTranscript("so first I went to the station and then", true);
    harness.clock.increment(4500);
    harness.vad?.emitSpeechEnd(4500);
    harness.clock.increment(300);
    harness.turnDetector?.emitProbability(0.1);

    harness.clock.increment(99);
    expect(harness.ofType("agent:backchannel")).toHaveLength(0);
    harness.clock.increment(1);
    expect(harness.ofType("agent:backchannel")).toHaveLength(1);
    harness.agent.stop();
  });

  it("does not backchannel while a reply is being prepared", () => {
    const harness = createListeningAgent();
    talk(harness, 4500, "so I was thinking", 0.6);
    expect(harness.llm.generations).toBe(1);

    harness.turnDetector?.emitProbability(0.1);
    harness.clock.increment(400);
    expect(harness.ofType("agent:backchannel")).toHaveLength(0);
    harness.agent.stop();
  });

  it("needs end-of-turn probabilities", () => {
    const harness = createTestAgent({ vad: true, backchannels: true });
    harness.agent.start();
    harness.vad?.emitSpeechStart();
    harness.stt.emitTranscript("so first I went to the station", false);
    harness.clock.increment(5000);
    harness.vad?.emitSpeechEnd(5000);
    harness.clock.increment(1000);
    expect(harness.ofType("agent:backchannel")).toHaveLength(0);
    harness.agent.stop();
  });

  it("is off with false", () => {
    const harness = createListeningAgent(false);
    talk(harness, 6000, "a long story", 0.05);
    harness.clock.increment(1000);
    expect(harness.ofType("agent:backchannel")).toHaveLength(0);
    harness.agent.stop();
  });
});

describe("VAD speech timing", () => {
  it.each([
    { reported: undefined, backchannels: 1 },
    { reported: 1000, backchannels: 0 },
  ])(
    "times speech from its start unless the VAD reports a duration: $reported",
    ({ reported, backchannels }) => {
      const harness = createTestAgent({
        vad: true,
        turnDetector: "probability",
        backchannels: true,
      });
      harness.agent.start();
      expect(harness.vad?.getContext()?.audioFormat).toEqual({
        encoding: "linear16",
        sampleRate: 16000,
        channels: 1,
      });

      harness.vad?.emitSpeechStart();
      harness.stt.emitTranscript("so first I went to the station", true);
      harness.clock.increment(4500);
      harness.vad?.emitSpeechEnd(reported);
      harness.turnDetector?.emitProbability(0.1);
      harness.clock.increment(400);
      expect(harness.ofType("agent:backchannel")).toHaveLength(backchannels);
      harness.agent.stop();
    },
  );
});
