import { describe, expect, it } from "vitest";

import { endOfTurnDelayMs, resolveTurnTakingConfig } from "../../src/agent/turn-taking";
import { audioChunk, createTestAgent } from "../helpers/agent-harness";

function createPredictionAgent() {
  return createTestAgent({
    vad: true,
    turnDetector: true,
    turnDetectorMode: "prediction",
    turnTaking: { minEndOfTurnDelayMs: 400, maxEndOfTurnDelayMs: 2500, endOfTurnThreshold: 0.7 },
  });
}

describe("turn detector speech events", () => {
  it("receives STT speech events when no VAD is configured", () => {
    const { agent, stt, turnDetector, clock } = createTestAgent({ turnDetector: true });

    agent.start();
    stt.emitSpeechStart();
    clock.increment(320);
    stt.emitSpeechEnd();

    expect(turnDetector?.receivedSpeechStarts).toBe(1);
    expect(turnDetector?.receivedSpeechEnds).toEqual([320]);
    agent.stop();
  });

  it("receives VAD speech events and ignores STT ones when a VAD is configured", () => {
    const { agent, stt, vad, turnDetector, clock } = createTestAgent({
      vad: true,
      turnDetector: true,
    });

    agent.start();
    vad?.emitSpeechStart();
    stt.emitSpeechStart();
    clock.increment(200);
    vad?.emitSpeechEnd(200);
    stt.emitSpeechEnd();

    expect(turnDetector?.receivedSpeechStarts).toBe(1);
    expect(turnDetector?.receivedSpeechEnds).toEqual([200]);
    agent.stop();
  });

  it("receives input audio and the conversation as it changes", () => {
    const { agent, stt, llm, tts, turnDetector } = createTestAgent({ turnDetector: true });

    agent.start();
    agent.sendAudio(new Uint8Array([1, 2]));
    expect(turnDetector?.receivedAudio).toHaveLength(1);

    turnDetector?.emitTurnEnd("what time is it");
    expect(turnDetector?.receivedContexts.at(-1)).toEqual([
      { role: "user", content: "what time is it" },
    ]);

    llm.emitSentence("It is noon.", 0);
    tts.emitAudio(audioChunk(1));
    llm.complete("It is noon.");
    tts.complete();
    expect(turnDetector?.receivedContexts.at(-1)).toEqual([
      { role: "user", content: "what time is it" },
      { role: "assistant", content: "It is noon." },
    ]);
    expect(stt.receivedAudio).toHaveLength(1);
    agent.stop();
  });
});

describe("prediction-mode turn detectors", () => {
  it("waits longer before ending the turn when the user is probably not done", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createPredictionAgent();
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("my number is five five five", true);
    clock.increment(600);
    vad?.emitSpeechEnd(600);
    turnDetector?.emitEndOfTurnProbability(0.1);

    clock.increment(2100);
    expect(ofType("human-turn:ended")).toHaveLength(0);

    clock.increment(100);
    expect(ofType("human-turn:ended")).toMatchObject([
      { transcript: "my number is five five five" },
    ]);
    agent.stop();
  });

  it("ends the turn quickly when the detector is confident", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createPredictionAgent();
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("what is the weather today?", true);
    vad?.emitSpeechEnd(500);
    turnDetector?.emitEndOfTurnProbability(0.95);

    clock.increment(399);
    expect(ofType("human-turn:ended")).toHaveLength(0);
    clock.increment(1);
    expect(ofType("human-turn:ended")).toHaveLength(1);
    expect(ofType("ai-turn:started")).toHaveLength(1);
    agent.stop();
  });

  it("measures the delay from when speech ended, not from when the prediction arrived", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createPredictionAgent();
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("book it", true);
    vad?.emitSpeechEnd(300);

    clock.increment(300);
    turnDetector?.emitEndOfTurnProbability(0.9);
    clock.increment(99);
    expect(ofType("human-turn:ended")).toHaveLength(0);
    clock.increment(1);
    expect(ofType("human-turn:ended")).toHaveLength(1);
    agent.stop();
  });

  it("keeps the turn open when the user resumes after a pause", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createPredictionAgent();
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("I want to fly to", true);
    vad?.emitSpeechEnd(400);
    turnDetector?.emitEndOfTurnProbability(0.2);

    clock.increment(300);
    vad?.emitSpeechStart();
    clock.increment(3000);
    expect(ofType("human-turn:ended")).toHaveLength(0);

    stt.emitTranscript("Paris next week", true);
    vad?.emitSpeechEnd(900);
    turnDetector?.emitEndOfTurnProbability(0.9);
    clock.increment(400);
    expect(ofType("human-turn:ended")).toMatchObject([
      { transcript: "I want to fly to Paris next week" },
    ]);
    agent.stop();
  });
});

describe("decision-mode turn sources", () => {
  it("does not end turns from predictions alone", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createTestAgent({
      vad: true,
      turnDetector: true,
    });
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("hello", true);
    vad?.emitSpeechEnd(300);
    turnDetector?.emitEndOfTurnProbability(1);

    clock.increment(10_000);
    expect(ofType("human-turn:ended")).toHaveLength(0);
    turnDetector?.emitTurnEnd("");
    expect(ofType("human-turn:ended")).toMatchObject([{ transcript: "hello" }]);
    agent.stop();
  });

  it("uses an STT provider's native turn signals instead of its final transcripts", () => {
    const { agent, stt, ofType } = createTestAgent({ sttTurnDetection: true });
    agent.start();
    stt.emitTranscript("hello", true);
    expect(ofType("human-turn:ended")).toHaveLength(0);

    stt.turn.turnEnd("hello there");
    expect(ofType("human-turn:ended")).toMatchObject([{ transcript: "hello there" }]);
    agent.stop();
  });

  it("ignores an STT provider's turn signals when a turn detector is configured", () => {
    const { agent, stt, turnDetector, ofType } = createTestAgent({
      sttTurnDetection: true,
      turnDetector: true,
    });
    agent.start();
    stt.emitTranscript("hello", true);
    stt.turn.turnEnd("hello");
    expect(ofType("human-turn:ended")).toHaveLength(0);

    turnDetector?.emitTurnEnd("hello");
    expect(ofType("human-turn:ended")).toHaveLength(1);
    agent.stop();
  });
});

describe("turn-taking policy", () => {
  it("resolves eagerness presets and lets explicit delays override them", () => {
    expect(resolveTurnTakingConfig(undefined)).toEqual({
      minEndOfTurnDelayMs: 400,
      maxEndOfTurnDelayMs: 2500,
      endOfTurnThreshold: 0.7,
      preemptiveGeneration: true,
      eagerEndOfTurnThreshold: 0.5,
    });
    expect(
      resolveTurnTakingConfig({ endOfTurnThreshold: 0.6, eagerEndOfTurnThreshold: 0.9 }),
    ).toMatchObject({ eagerEndOfTurnThreshold: 0.6 });
    expect(resolveTurnTakingConfig({ eagerness: "low" })).toMatchObject({
      minEndOfTurnDelayMs: 800,
      maxEndOfTurnDelayMs: 5000,
    });
    expect(resolveTurnTakingConfig({ eagerness: "high", maxEndOfTurnDelayMs: 100 })).toMatchObject({
      minEndOfTurnDelayMs: 200,
      maxEndOfTurnDelayMs: 200,
    });
  });

  it("scales the delay between the bounds by confidence", () => {
    const config = resolveTurnTakingConfig({
      minEndOfTurnDelayMs: 400,
      maxEndOfTurnDelayMs: 2500,
      endOfTurnThreshold: 0.7,
    });
    expect(endOfTurnDelayMs(null, config)).toBe(2500);
    expect(endOfTurnDelayMs(0, config)).toBe(2500);
    expect(endOfTurnDelayMs(0.35, config)).toBe(1450);
    expect(endOfTurnDelayMs(0.7, config)).toBe(400);
    expect(endOfTurnDelayMs(1, config)).toBe(400);
  });
});
