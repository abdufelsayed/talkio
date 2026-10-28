import { describe, expect, it } from "vitest";

import { audioChunk, bytesOf, createTestAgent, type TestAgent } from "../helpers/agent-harness";

function createListeningAgent(options: { interruption?: boolean; phrases?: string[] } = {}) {
  const harness = createTestAgent({
    interruption: options.interruption,
    vad: true,
    turnDetector: "probability",
    turnTaking: { minDelayMs: 400, maxDelayMs: 2500, threshold: 0.7 },
    backchannels: { phrases: options.phrases ?? ["Mm-hmm."] },
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
  harness.turnDetector?.emitProbability(0.1);
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
      fillers: { afterMs: 100, phrases: ["One moment."] },
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

  it.each([
    { phrases: ["Mm-hmm."], backchannels: 2 },
    { phrases: ["Mm-hmm.", "Uh-huh."], backchannels: 1 },
  ])("backchannels over a prepared reply only with a recorded phrase: $phrases", (example) => {
    const harness = createListeningAgent({ phrases: example.phrases });
    talkAndPause(harness, "so first I went to the station");
    harness.tts.emitAudio(audioChunk(3, 4));
    harness.tts.complete();

    harness.vad?.emitSpeechStart();
    harness.stt.emitTranscript("and the train was not there", true);
    harness.clock.increment(4500);
    harness.vad?.emitSpeechEnd(4500);
    harness.turnDetector?.emitProbability(0.6);
    expect(harness.llm.getContext()?.isSpeculative()).toBe(true);
    harness.turnDetector?.emitProbability(0.1);
    harness.clock.increment(400);

    expect(harness.ofType("agent:backchannel")).toHaveLength(example.backchannels);
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm."]);
    expect(harness.llm.generations).toBe(1);
    expect(harness.llm.getContext()?.isSpeculative()).toBe(true);
    harness.agent.stop();
  });

  it("never backchannels over a reply the user can hear", () => {
    const harness = createListeningAgent({ interruption: false });
    talkAndPause(harness, "so first I went to the station");
    harness.tts.emitAudio(audioChunk(3, 4));
    harness.tts.complete();
    harness.turnDetector?.emitProbability(0.95);
    harness.llm.emitSentence("I see.", 0);
    harness.tts.emitAudio(audioChunk(5));

    talkAndPause(harness, "and the train was not there either");
    expect(harness.ofType("agent:backchannel")).toHaveLength(1);
    harness.agent.stop();
  });

  it("drops a backchannel the user talks over before it starts playing", () => {
    const harness = createListeningAgent();
    talkAndPause(harness, "so first I went to the station");
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm."]);

    harness.vad?.emitSpeechStart();
    expect(harness.tts.abortedIds).toHaveLength(1);
    harness.tts.emitAudio(audioChunk(3));
    expect(harness.ofType("ai-turn:audio")).toHaveLength(0);
    harness.stt.emitTranscript("Mm-hmm.", false);
    expect(harness.ofType("human-turn:transcript").at(-1)).toMatchObject({ text: "Mm-hmm." });

    harness.stt.emitTranscript("and the train was not there", true);
    harness.clock.increment(4500);
    harness.vad?.emitSpeechEnd(4500);
    harness.turnDetector?.emitProbability(0.1);
    harness.clock.increment(400);
    expect(harness.ofType("agent:backchannel")).toHaveLength(2);
    expect(harness.tts.requestedTexts).toEqual(["Mm-hmm.", "Mm-hmm."]);
    harness.agent.stop();
  });

  it("finishes a backchannel that is already playing when the user resumes", () => {
    const harness = createListeningAgent();
    talkAndPause(harness, "so first I went to the station");
    harness.tts.emitAudio(audioChunk(3));
    harness.vad?.emitSpeechStart();
    harness.tts.emitAudio(audioChunk(4));
    harness.tts.complete();

    expect(harness.tts.abortedIds).toHaveLength(0);
    expect(harness.ofType("ai-turn:audio").map((event) => bytesOf(event.audio))).toEqual([
      [3],
      [4],
    ]);
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
