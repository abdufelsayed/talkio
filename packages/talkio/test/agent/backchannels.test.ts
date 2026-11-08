import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/types/config";
import { audioChunk, bytesOf, createTestAgent, type TestAgent } from "../helpers/agent-harness";

function createListeningAgent(backchannels: AgentConfig["backchannels"] = true) {
  const harness = createTestAgent({
    vad: true,
    turnDetector: "probability",
    turnTaking: { minDelayMs: 400, maxDelayMs: 2500, threshold: 0.7 },
    backchannels,
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
