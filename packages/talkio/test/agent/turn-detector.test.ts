import { describe, expect, it, vi } from "vitest";
import { SimulatedClock } from "xstate";

import { createAgent } from "../../src";
import { endOfTurnDelayMs, resolveTurnTakingConfig } from "../../src/agent/turn-taking";
import type { AgentConfig } from "../../src/types/config";
import type { PublicAgentEvent } from "../../src/types/events";
import { audioChunk, createTestAgent } from "../helpers/agent-harness";
import {
  createFakeLLM,
  createFakeSTT,
  createFakeTTS,
  createFakeTurnDetector,
  createFakeVAD,
} from "../helpers/fake-providers";

function createPredictionAgent() {
  return createTestAgent({
    vad: true,
    turnDetector: "probability",
    turnTaking: { minDelayMs: 400, maxDelayMs: 2500, threshold: 0.7 },
  });
}

describe("turn detector inputs", () => {
  it("receives speech starts from the STT when no VAD is configured", () => {
    const { agent, stt, turnDetector } = createTestAgent({ turnDetector: "decision" });

    agent.start();
    stt.emitSpeechStart();
    stt.emitTranscript("hello", true);
    stt.emitSpeechEnd();

    expect(turnDetector?.receivedSpeechStarts).toBe(1);
    expect(turnDetector?.receivedPauses.map((pause) => pause.transcript)).toEqual(["hello"]);
    agent.stop();
  });

  it("receives VAD speech starts and ignores STT ones when a VAD is configured", () => {
    const { agent, stt, vad, turnDetector } = createTestAgent({
      vad: true,
      turnDetector: "decision",
    });

    agent.start();
    vad?.emitSpeechStart();
    stt.emitSpeechStart();
    stt.emitTranscript("hello", true);
    stt.emitSpeechEnd();
    expect(turnDetector?.receivedPauses).toHaveLength(0);

    vad?.emitSpeechEnd(200);
    expect(turnDetector?.receivedSpeechStarts).toBe(1);
    expect(turnDetector?.receivedPauses).toHaveLength(1);
    agent.stop();
  });

  it("receives input audio, and each pause with the conversation before the turn", () => {
    const { agent, vad, stt, llm, tts, turnDetector } = createTestAgent({
      vad: true,
      turnDetector: "decision",
    });

    agent.start();
    agent.sendAudio(new Uint8Array([1, 2]));
    expect(turnDetector?.receivedAudio).toHaveLength(1);
    expect(stt.receivedAudio).toHaveLength(1);

    vad?.emitSpeechStart();
    stt.emitTranscript("what time is it", true);
    vad?.emitSpeechEnd(500);
    expect(turnDetector?.receivedPauses.at(-1)).toMatchObject({
      transcript: "what time is it",
      messages: [],
    });
    turnDetector?.emitEnd();

    llm.emitSentence("It is noon.", 0);
    tts.emitAudio(audioChunk(1));
    llm.complete("It is noon.");
    tts.complete();
    vad?.emitSpeechStart();
    stt.emitTranscript("thanks", true);
    vad?.emitSpeechEnd(300);
    expect(turnDetector?.receivedPauses.at(-1)).toMatchObject({
      transcript: "thanks",
      messages: [
        { role: "user", content: "what time is it" },
        { role: "assistant", content: "It is noon." },
      ],
    });
    agent.stop();
  });

  it("scores the pause again when a transcript arrives during it, and aborts the earlier one", () => {
    const { agent, vad, stt, turnDetector } = createTestAgent({
      vad: true,
      turnDetector: "decision",
    });

    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("I want to", false);
    vad?.emitSpeechEnd(400);
    stt.emitTranscript("I want to go", true);

    const [first, second] = turnDetector?.receivedPauses ?? [];
    expect(first).toMatchObject({ transcript: "I want to" });
    expect(second).toMatchObject({ transcript: "I want to go" });
    expect(first?.signal.aborted).toBe(true);
    expect(second?.signal.aborted).toBe(false);

    vad?.emitSpeechStart();
    expect(second?.signal.aborted).toBe(true);
    agent.stop();
  });

  it("aborts the pause when the turn ends", () => {
    const { agent, vad, stt, turnDetector } = createTestAgent({
      vad: true,
      turnDetector: "decision",
    });

    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("hello", true);
    vad?.emitSpeechEnd(400);
    turnDetector?.emitEnd();
    expect(turnDetector?.receivedPauses[0]?.signal.aborted).toBe(true);
    agent.stop();
  });
});

describe("turn detector functions", () => {
  function createFunctionAgent(
    turnDetector: AgentConfig["turnDetector"],
    turnTaking = { minDelayMs: 400, maxDelayMs: 2500 },
  ) {
    const stt = createFakeSTT();
    const vad = createFakeVAD();
    const clock = new SimulatedClock();
    const events: PublicAgentEvent[] = [];
    const agent = createAgent({
      stt: stt.provider,
      llm: createFakeLLM().provider,
      tts: createFakeTTS().provider,
      vad: vad.provider,
      turnDetector,
      turnTaking,
      clock,
      onEvent: (event) => events.push(event),
    });
    agent.start();
    const pause = (text: string) => {
      vad.emitSpeechStart();
      stt.emitTranscript(text, true);
      vad.emitSpeechEnd(500);
    };
    const ended = () => events.filter((event) => event.type === "user-turn:ended");
    const errors = () => events.filter((event) => event.type === "agent:error");
    return { agent, stt, vad, clock, pause, ended, errors };
  }

  it("ends the turn from the probability a function returns", () => {
    const calls: string[] = [];
    const { agent, clock, pause, ended } = createFunctionAgent(({ transcript }) => {
      calls.push(transcript);
      return transcript.endsWith("?") ? 0.95 : 0.1;
    });

    pause("what is the weather?");
    clock.increment(400);
    expect(calls).toEqual(["what is the weather?"]);
    expect(ended()).toHaveLength(1);
    agent.stop();
  });

  it("counts the pause from the voice end when the final transcript arrives later", () => {
    const stt = createFakeSTT();
    const vad = createFakeVAD();
    const clock = new SimulatedClock();
    const ended: number[] = [];
    const agent = createAgent({
      stt: stt.provider,
      llm: createFakeLLM().provider,
      tts: createFakeTTS().provider,
      vad: vad.provider,
      turnDetector: () => 0.95,
      turnTaking: { minDelayMs: 400, maxDelayMs: 2500 },
      clock,
      onEvent: (event) => {
        if (event.type === "user-turn:ended") ended.push(clock.now());
      },
    });
    agent.start();

    vad.emitSpeechStart();
    stt.emitTranscript("what is the", false);
    vad.emitSpeechEnd(500);
    clock.increment(250);
    stt.emitTranscript("what is the weather?", true);
    clock.increment(149);
    expect(ended).toEqual([]);
    clock.increment(1);
    expect(ended).toEqual([400]);
    agent.stop();
  });

  it("counts the pause from the transcript when the voice ended before the turn began", () => {
    const { agent, stt, vad, clock, ended } = createFunctionAgent(() => 0.95);

    vad.emitSpeechStart();
    vad.emitSpeechEnd(300);
    clock.increment(3000);
    stt.emitTranscript("are you there?", true);
    clock.increment(399);
    expect(ended()).toHaveLength(0);
    clock.increment(1);
    expect(ended()).toHaveLength(1);
    agent.stop();
  });

  it.each(["alone", "combined"])(
    "uses an async result that arrives during the pause and drops one that arrives after (%s)",
    async (setup) => {
      const pending: Array<(probability: number) => void> = [];
      const score = () => new Promise<number>((resolve) => pending.push(resolve));
      const { agent, vad, clock, pause, ended } = createFunctionAgent(
        setup === "alone" ? score : [score, () => 0],
      );

      pause("I want to fly to");
      vad.emitSpeechStart();
      pending[0]?.(0.95);
      await Promise.resolve();
      vad.emitSpeechEnd(500);
      clock.increment(400);
      expect(ended()).toHaveLength(0);

      pending[1]?.(0.95);
      await Promise.resolve();
      clock.increment(1);
      expect(ended()).toHaveLength(1);
      agent.stop();
    },
  );

  it("reports a thrown or rejected error from the detector and ignores aborts", async () => {
    const failures = [
      () => {
        throw new Error("model crashed");
      },
      () => Promise.reject(new Error("model timed out")),
      () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    ];
    let call = 0;
    const { agent, pause, errors } = createFunctionAgent(() => {
      const fail = failures[call++];
      return fail ? fail() : 0;
    });

    pause("one");
    pause("two");
    pause("three");
    await vi.waitFor(() => expect(errors()).toHaveLength(2));
    await Promise.resolve();
    expect(errors()).toMatchObject([
      { source: "turnDetector", error: { message: "model crashed" } },
      { source: "turnDetector", error: { message: "model timed out" } },
    ]);
    expect(agent.getSnapshot().metrics.errors.bySource.turnDetector).toBe(2);
    agent.stop();
  });

  it("reports a detector that fails to start", async () => {
    const { agent, errors } = createFunctionAgent({
      start: () => Promise.reject(new Error("model not found")),
    });
    await vi.waitFor(() =>
      expect(errors()).toMatchObject([
        { source: "turnDetector", error: { message: "model not found" } },
      ]),
    );
    agent.stop();
  });

  it("combines several detectors: the highest probability counts", () => {
    const { agent, clock, pause, ended } = createFunctionAgent([() => 0.1, () => 0.9, () => 0.2]);

    pause("book it");
    clock.increment(399);
    expect(ended()).toHaveLength(0);
    clock.increment(1);
    expect(ended()).toHaveLength(1);
    agent.stop();
  });

  it("combines a streaming detector with a function and forgets its probability once the user speaks", () => {
    const streaming = createFakeTurnDetector({ output: "decision" });
    const { agent, clock, pause, ended } = createFunctionAgent([streaming.provider, () => 0]);

    streaming.emitProbability(0.95);
    pause("I was thinking");
    clock.increment(400);
    expect(ended()).toHaveLength(0);

    streaming.emitProbability(0.95);
    expect(ended()).toHaveLength(1);
    agent.stop();
  });

  it("keeps scoring with the other detectors when a combined one fails", async () => {
    const { agent, clock, pause, ended, errors } = createFunctionAgent([
      {
        start: () => Promise.reject(new Error("model not found")),
        onPause: () => {
          throw new Error("model crashed");
        },
      },
      () => Promise.reject(new Error("timed out")),
      () => 0.9,
    ]);

    pause("book it");
    clock.increment(400);
    expect(ended()).toHaveLength(1);
    await vi.waitFor(() => expect(errors()).toHaveLength(3));
    expect(new Set(errors().map((event) => event.error.message))).toEqual(
      new Set(["model crashed", "model not found", "timed out"]),
    );
    agent.stop();
  });

  it("lets any combined detector end the turn", () => {
    const streaming = createFakeTurnDetector({ output: "decision" });
    const { agent, pause, ended } = createFunctionAgent([streaming.provider, () => 0]);

    pause("hello");
    streaming.emitEnd();
    expect(ended()).toMatchObject([{ text: "hello" }]);
    agent.stop();
  });

  it("waits for a decision when every combined detector decides", () => {
    const first = createFakeTurnDetector({ output: "decision" });
    const second = createFakeTurnDetector({ output: "decision" });
    const { agent, clock, pause, ended } = createFunctionAgent([first.provider, second.provider]);

    pause("hello");
    first.emitProbability(1);
    clock.increment(10_000);
    expect(ended()).toHaveLength(0);
    second.emitEnd();
    expect(ended()).toHaveLength(1);
    expect(first.stopped).toBe(false);
    agent.stop();
    expect([first.stopped, second.stopped]).toEqual([true, true]);
  });
});

describe("probability turn detectors", () => {
  it("waits longer before ending the turn when the user is probably not done", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createPredictionAgent();
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("my number is five five five", true);
    clock.increment(600);
    vad?.emitSpeechEnd(600);
    turnDetector?.emitProbability(0.1);

    clock.increment(2100);
    expect(ofType("user-turn:ended")).toHaveLength(0);

    clock.increment(100);
    expect(ofType("user-turn:ended")).toMatchObject([{ text: "my number is five five five" }]);
    agent.stop();
  });

  it("ends the turn quickly when the detector is confident", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createPredictionAgent();
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("what is the weather today?", true);
    vad?.emitSpeechEnd(500);
    turnDetector?.emitProbability(0.95);

    clock.increment(399);
    expect(ofType("user-turn:ended")).toHaveLength(0);
    clock.increment(1);
    expect(ofType("user-turn:ended")).toHaveLength(1);
    expect(ofType("agent-turn:started")).toHaveLength(1);
    agent.stop();
  });

  it("measures the delay from when speech ended, not from when the prediction arrived", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createPredictionAgent();
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("book it", true);
    vad?.emitSpeechEnd(300);

    clock.increment(300);
    turnDetector?.emitProbability(0.9);
    clock.increment(99);
    expect(ofType("user-turn:ended")).toHaveLength(0);
    clock.increment(1);
    expect(ofType("user-turn:ended")).toHaveLength(1);
    agent.stop();
  });

  it("keeps the turn open when the user resumes after a pause", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createPredictionAgent();
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("I want to fly to", true);
    vad?.emitSpeechEnd(400);
    turnDetector?.emitProbability(0.2);

    clock.increment(300);
    vad?.emitSpeechStart();
    clock.increment(3000);
    expect(ofType("user-turn:ended")).toHaveLength(0);

    stt.emitTranscript("Paris next week", true);
    vad?.emitSpeechEnd(900);
    turnDetector?.emitProbability(0.9);
    clock.increment(400);
    expect(ofType("user-turn:ended")).toMatchObject([{ text: "I want to fly to Paris next week" }]);
    agent.stop();
  });
});

describe("words reported after the turn ended", () => {
  function endTurnEarly() {
    const harness = createPredictionAgent();
    harness.agent.start();
    harness.vad?.emitSpeechStart();
    harness.stt.emitTranscript("book a table", false);
    harness.vad?.emitSpeechEnd(500);
    harness.turnDetector?.emitProbability(0.95);
    harness.clock.increment(400);
    expect(harness.ofType("user-turn:ended")).toMatchObject([{ text: "book a table" }]);
    return harness;
  }

  it.each(["while the agent prepares its reply", "after the reply"])(
    "does not start a turn that only restates the one it ended, %s",
    (when) => {
      const harness = endTurnEarly();
      if (when === "after the reply") {
        harness.llm.emitSentence("Sure.", 0);
        harness.tts.emitAudio(audioChunk(1));
        harness.llm.complete("Sure.");
        harness.tts.complete();
        expect(harness.ofType("agent-turn:ended")).toHaveLength(1);
      }
      harness.stt.emitTranscript("Book a table.", true);
      harness.turnDetector?.emitEnd("book a table");
      expect(harness.ofType("user-turn:ended")).toHaveLength(1);
      expect(harness.ofType("user-turn:started")).toHaveLength(1);
      harness.agent.stop();
    },
  );

  it("starts a turn when the user says the same words again", () => {
    const harness = endTurnEarly();
    harness.llm.emitSentence("Sure.", 0);
    harness.tts.emitAudio(audioChunk(1));
    harness.llm.complete("Sure.");
    harness.tts.complete();

    harness.vad?.emitSpeechStart();
    harness.stt.emitTranscript("book a table", true);
    harness.vad?.emitSpeechEnd(500);
    harness.turnDetector?.emitEnd("book a table");
    expect(harness.ofType("user-turn:ended").map((event) => event.text)).toEqual([
      "book a table",
      "book a table",
    ]);
    harness.agent.stop();
  });

  it("starts a turn from the same words once the agent has had time to hear the rest", () => {
    const harness = endTurnEarly();
    harness.llm.emitSentence("Sure.", 0);
    harness.tts.emitAudio(audioChunk(1));
    harness.llm.complete("Sure.");
    harness.tts.complete();
    harness.clock.increment(5001);
    harness.turnDetector?.emitEnd("book a table");
    expect(harness.ofType("user-turn:ended")).toHaveLength(2);
    harness.agent.stop();
  });

  it("starts a turn from the same words when the ended turn had its final transcript", () => {
    const harness = createTestAgent();
    harness.agent.start();
    harness.stt.emitTranscript("yes", true);
    harness.llm.emitSentence("And at three?", 0);
    harness.tts.emitAudio(audioChunk(1));
    harness.llm.complete("And at three?");
    harness.tts.complete();
    harness.stt.emitTranscript("yes", true);
    expect(harness.ofType("user-turn:ended").map((event) => event.text)).toEqual(["yes", "yes"]);
    harness.agent.stop();
  });

  it("starts a turn from new words", () => {
    const harness = endTurnEarly();
    harness.turnDetector?.emitEnd("book a table for two");
    expect(harness.ofType("user-turn:ended").map((event) => event.text)).toEqual([
      "book a table",
      "book a table for two",
    ]);
    harness.agent.stop();
  });
});

describe("decision turn sources", () => {
  it("does not end turns from predictions alone", () => {
    const { agent, vad, stt, turnDetector, clock, ofType } = createTestAgent({
      vad: true,
      turnDetector: "decision",
    });
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("hello", true);
    vad?.emitSpeechEnd(300);
    turnDetector?.emitProbability(1);

    clock.increment(10_000);
    expect(ofType("user-turn:ended")).toHaveLength(0);
    turnDetector?.emitEnd("");
    expect(ofType("user-turn:ended")).toMatchObject([{ text: "hello" }]);
    agent.stop();
  });

  it("uses an STT provider's native turn signals instead of its final transcripts", () => {
    const { agent, stt, ofType } = createTestAgent({ sttTurnDetection: true });
    agent.start();
    stt.emitTranscript("hello", true);
    expect(ofType("user-turn:ended")).toHaveLength(0);

    stt.turn.end("hello there");
    expect(ofType("user-turn:ended")).toMatchObject([{ text: "hello there" }]);
    agent.stop();
  });

  it("starts one turn when an interruption is reported as a final transcript and a turn end", () => {
    const { agent, stt, llm, tts, ofType } = createTestAgent({ sttTurnDetection: true });
    agent.start();
    stt.turn.end("tell me a story");
    llm.emitSentence("Once upon a time.", 0);
    tts.emitAudio(audioChunk(1));

    stt.emitSpeechStart();
    stt.emitTranscript("actually never mind", true);
    stt.turn.end("actually never mind");

    expect(ofType("agent-turn:interrupted")).toHaveLength(1);
    expect(ofType("user-turn:ended").map((event) => event.text)).toEqual([
      "tell me a story",
      "actually never mind",
    ]);
    expect(ofType("agent-turn:started")).toHaveLength(2);
    expect(agent.getSnapshot().messages).toEqual([
      { role: "user", content: "tell me a story" },
      { role: "user", content: "actually never mind" },
    ]);
    agent.stop();
  });

  it("ignores an STT provider's turn signals when a turn detector is configured", () => {
    const { agent, stt, turnDetector, ofType } = createTestAgent({
      sttTurnDetection: true,
      turnDetector: "decision",
    });
    agent.start();
    stt.emitTranscript("hello", true);
    stt.turn.end("hello");
    expect(ofType("user-turn:ended")).toHaveLength(0);

    turnDetector?.emitEnd("hello");
    expect(ofType("user-turn:ended")).toHaveLength(1);
    agent.stop();
  });
});

describe("turn-taking policy", () => {
  it("resolves eagerness presets and lets explicit delays override them", () => {
    expect(resolveTurnTakingConfig(undefined)).toEqual({
      minDelayMs: 400,
      maxDelayMs: 2500,
      threshold: 0.7,
      preemptiveGeneration: true,
      eagerThreshold: 0.5,
    });
    expect(resolveTurnTakingConfig({ threshold: 0.6, eagerThreshold: 0.9 })).toMatchObject({
      eagerThreshold: 0.6,
    });
    expect(resolveTurnTakingConfig({ eagerness: "low" })).toMatchObject({
      minDelayMs: 800,
      maxDelayMs: 5000,
    });
    expect(resolveTurnTakingConfig({ eagerness: "high", maxDelayMs: 100 })).toMatchObject({
      minDelayMs: 200,
      maxDelayMs: 200,
    });
  });

  it("scales the delay between the bounds by confidence", () => {
    const config = resolveTurnTakingConfig({
      minDelayMs: 400,
      maxDelayMs: 2500,
      threshold: 0.7,
    });
    expect(endOfTurnDelayMs(null, config)).toBe(2500);
    expect(endOfTurnDelayMs(0, config)).toBe(2500);
    expect(endOfTurnDelayMs(0.35, config)).toBe(1450);
    expect(endOfTurnDelayMs(0.7, config)).toBe(400);
    expect(endOfTurnDelayMs(1, config)).toBe(400);
  });
});
