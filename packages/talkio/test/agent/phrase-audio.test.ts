import { describe, expect, it } from "vitest";

import { audioChunk, bytesOf, createTestAgent, type TestAgent } from "../helpers/agent-harness";

function createListeningAgent() {
  const harness = createTestAgent({
    vad: true,
    turnDetector: true,
    turnDetectorMode: "prediction",
    turnTaking: { minEndOfTurnDelayMs: 400, maxEndOfTurnDelayMs: 2500, endOfTurnThreshold: 0.7 },
    backchannels: { enabled: true, phrases: ["Mm-hmm."] },
  });
  harness.agent.start();
  return harness;
}

/** The user talks at length and pauses mid-thought, long enough for a backchannel. */
function talkAndPause(harness: TestAgent, text: string) {
  harness.vad?.emitSpeechStart();
  harness.stt.emitTranscript(text, true);
  harness.clock.increment(4500);
  harness.vad?.emitSpeechEnd(4500);
  harness.turnDetector?.emitEndOfTurnProbability(0.1);
  harness.clock.increment(400);
}

function audioOf(harness: TestAgent, turnId: string | undefined) {
  return harness
    .ofType("ai-turn:audio")
    .filter((event) => event.turnId === turnId)
    .map((event) => bytesOf(event.audio));
}

describe("recorded phrase audio", () => {
  it("replays a backchannel it has synthesized before", () => {
    const harness = createListeningAgent();
    talkAndPause(harness, "so first I went to the station");
    harness.tts.emitAudio(audioChunk(3, 4));
    harness.tts.complete();

    talkAndPause(harness, "and the train was not there");
    const [, second] = harness.ofType("agent:backchannel");
    expect(second).toBeDefined();
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm."]);
    expect(audioOf(harness, second?.turnId)).toEqual([[3, 4]]);
    harness.agent.stop();
  });

  it("replays a filler without waiting for the TTS, then speaks the reply", () => {
    const harness = createTestAgent({
      fillers: { enabled: true, afterMs: 100, phrases: ["One moment."] },
    });
    harness.agent.start();
    harness.stt.emitTranscript("first question", true);
    harness.clock.increment(100);
    harness.tts.emitAudio(audioChunk(5, 6));
    harness.tts.complete();
    harness.llm.emitSentence("First answer.", 0);
    harness.tts.emitAudio(audioChunk(1));
    harness.tts.complete();
    harness.llm.complete("First answer.");

    harness.stt.emitTranscript("second question", true);
    harness.clock.increment(100);
    const [, second] = harness.ofType("ai-turn:started");
    expect(audioOf(harness, second?.turnId)).toEqual([[5, 6]]);
    harness.llm.emitSentence("Second answer.", 0);
    expect(harness.tts.requestedTexts).toEqual(["One moment.", "First answer.", "Second answer."]);

    harness.tts.emitAudio(audioChunk(2));
    harness.tts.complete();
    harness.llm.complete("Second answer.");
    expect(harness.ofType("ai-turn:ended").at(-1)).toMatchObject({ text: "Second answer." });
    harness.agent.stop();
  });

  it("synthesizes a phrase again after a failed attempt", () => {
    const harness = createListeningAgent();
    talkAndPause(harness, "so first I went to the station");
    harness.tts.emitAudio(audioChunk(3));
    harness.tts.error(new Error("synthesis failed"));

    talkAndPause(harness, "and the train was not there");
    expect(harness.ofType("agent:backchannel")).toHaveLength(2);
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm.", "Mm-hmm."]);
    harness.agent.stop();
  });

  it("does not keep what the LLM says itself, which varies", () => {
    const harness = createTestAgent();
    harness.agent.start();
    for (const question of ["one", "two"]) {
      harness.stt.emitTranscript(question, true);
      harness.llm.say("Let me look that up.");
      harness.tts.emitAudio(audioChunk(1));
      harness.tts.complete();
      harness.llm.complete("");
    }
    expect(harness.tts.requestedTexts).toEqual(["Let me look that up.", "Let me look that up."]);
    harness.agent.stop();
  });
});
