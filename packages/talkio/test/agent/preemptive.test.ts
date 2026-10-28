import { describe, expect, it } from "vitest";

import { audioChunk, bytesOf, createTestAgent } from "../helpers/agent-harness";

function createDecisionAgent(options: { preemptiveGeneration?: boolean } = {}) {
  return createTestAgent({
    turnDetector: "decision",
    turnTaking: { preemptiveGeneration: options.preemptiveGeneration },
  });
}

describe("preemptive generation", () => {
  it("prepares the reply silently and releases it when the turn is confirmed", () => {
    const harness = createDecisionAgent();
    const { agent, stt, llm, tts, turnDetector, ofType, events } = harness;
    agent.start();
    stt.emitTranscript("book a table for two", true);

    turnDetector?.emitEagerEnd("book a table for two");
    expect(llm.generations).toBe(1);
    expect(llm.messages).toEqual([{ role: "user", content: "book a table for two" }]);
    expect(llm.getContext()?.isSpeculative()).toBe(true);

    llm.emitToken("Sure.");
    llm.emitSentence("Sure.", 0);
    tts.emitAudio(audioChunk(4, 2));
    expect(ofType("ai-turn:started")).toHaveLength(0);
    expect(ofType("ai-turn:token")).toHaveLength(0);
    expect(ofType("ai-turn:audio")).toHaveLength(0);
    expect(agent.getSnapshot().isSpeaking).toBe(false);

    turnDetector?.emitEnd("book a table for two");
    expect(llm.generations).toBe(1);
    expect(llm.getContext()?.isSpeculative()).toBe(false);
    expect(
      events
        .map((event) => event.type)
        .filter((type) => type.startsWith("ai-turn") || type === "human-turn:ended"),
    ).toEqual([
      "human-turn:ended",
      "ai-turn:started",
      "ai-turn:token",
      "ai-turn:sentence",
      "ai-turn:audio",
    ]);
    expect(bytesOf(ofType("ai-turn:audio")[0]?.audio)).toEqual([4, 2]);
    expect(agent.getSnapshot().messages).toEqual([
      { role: "user", content: "book a table for two" },
    ]);

    llm.complete("Sure.");
    tts.complete();
    expect(ofType("ai-turn:ended")).toMatchObject([{ text: "Sure.", wasSpoken: true }]);
    agent.stop();
  });

  it("discards the prepared reply when the user resumes", () => {
    const harness = createDecisionAgent();
    const { agent, stt, llm, tts, turnDetector, ofType } = harness;
    agent.start();
    stt.emitTranscript("book a table", true);
    turnDetector?.emitEagerEnd("book a table");
    llm.emitSentence("For how many?", 0);
    const preparedRequest = tts.getCurrentRequest();

    turnDetector?.emitResumed();
    expect(llm.aborted).toBe(true);
    expect(tts.abortedIds).toContain(preparedRequest?.id);

    stt.emitTranscript("for two at eight", true);
    turnDetector?.emitEnd("book a table for two at eight");
    expect(llm.generations).toBe(2);
    expect(llm.messages).toEqual([{ role: "user", content: "book a table for two at eight" }]);
    expect(ofType("ai-turn:started")).toHaveLength(1);
    expect(ofType("ai-turn:sentence")).toHaveLength(0);
    agent.stop();
  });

  it("regenerates when the confirmed transcript differs from the prepared one", () => {
    const harness = createDecisionAgent();
    const { agent, llm, turnDetector, ofType } = harness;
    agent.start();
    turnDetector?.emitEagerEnd("call mom");
    llm.emitToken("Calling mom.");

    turnDetector?.emitEnd("call mom tomorrow");
    expect(llm.generations).toBe(2);
    expect(llm.messages).toEqual([{ role: "user", content: "call mom tomorrow" }]);
    expect(ofType("ai-turn:token")).toHaveLength(0);
    agent.stop();
  });

  it("keeps the prepared reply when the confirmed transcript only adds punctuation", () => {
    const harness = createDecisionAgent();
    const { agent, llm, turnDetector, ofType } = harness;
    agent.start();
    turnDetector?.emitEagerEnd("what time do you open");
    llm.emitToken("We open at nine.");

    turnDetector?.emitEnd("What time do you open?");
    expect(llm.generations).toBe(1);
    expect(ofType("ai-turn:token")).toMatchObject([{ token: "We open at nine." }]);
    agent.stop();
  });

  it("lets the LLM wait for the turn to commit before side effects", async () => {
    const harness = createDecisionAgent();
    const { agent, llm, turnDetector } = harness;
    agent.start();

    turnDetector?.emitEagerEnd("buy the ticket");
    const discarded = llm.getContext()?.turnConfirmed();
    turnDetector?.emitResumed();
    await expect(discarded).resolves.toBe(false);

    turnDetector?.emitEagerEnd("buy the ticket now");
    const committed = llm.getContext()?.turnConfirmed();
    turnDetector?.emitEnd("buy the ticket now");
    await expect(committed).resolves.toBe(true);
    agent.stop();
  });

  it("does not prepare replies when preemptive generation is disabled", () => {
    const harness = createDecisionAgent({ preemptiveGeneration: false });
    const { agent, llm, turnDetector } = harness;
    agent.start();
    turnDetector?.emitEagerEnd("hello");
    expect(llm.generations).toBe(0);

    turnDetector?.emitEnd("hello");
    expect(llm.generations).toBe(1);
    expect(llm.getContext()?.isSpeculative()).toBe(false);
    agent.stop();
  });

  it("starts preparing once a prediction crosses the eager threshold", () => {
    const harness = createTestAgent({
      vad: true,
      turnDetector: "probability",
      turnTaking: {
        minEndOfTurnDelayMs: 400,
        maxEndOfTurnDelayMs: 2500,
        endOfTurnThreshold: 0.8,
        eagerEndOfTurnThreshold: 0.5,
      },
    });
    const { agent, vad, stt, llm, turnDetector, clock, ofType } = harness;
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("what is the weather", true);
    vad?.emitSpeechEnd(800);

    turnDetector?.emitProbability(0.3);
    expect(llm.generations).toBe(0);
    turnDetector?.emitProbability(0.6);
    expect(llm.generations).toBe(1);
    expect(llm.getContext()?.isSpeculative()).toBe(true);

    vad?.emitSpeechStart();
    expect(llm.aborted).toBe(true);
    stt.emitTranscript("in Paris", true);
    vad?.emitSpeechEnd(500);
    turnDetector?.emitProbability(0.9);
    expect(llm.generations).toBe(2);

    clock.increment(400);
    expect(ofType("human-turn:ended")).toMatchObject([
      { transcript: "what is the weather in Paris" },
    ]);
    expect(llm.generations).toBe(2);
    expect(llm.getContext()?.isSpeculative()).toBe(false);
    agent.stop();
  });

  it("keeps preparing when the final transcript only punctuates the interim one", () => {
    const harness = createTestAgent({
      vad: true,
      turnDetector: "probability",
      turnTaking: { minEndOfTurnDelayMs: 400, maxEndOfTurnDelayMs: 2500 },
    });
    const { agent, vad, stt, llm, turnDetector, clock, ofType } = harness;
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("what time do you open", false);
    vad?.emitSpeechEnd(800);
    turnDetector?.emitProbability(0.6);
    expect(llm.generations).toBe(1);

    stt.emitTranscript("What time do you open?", true);
    turnDetector?.emitProbability(0.9);
    clock.increment(400);
    expect(ofType("human-turn:ended")).toMatchObject([{ transcript: "What time do you open?" }]);
    expect(llm.generations).toBe(1);
    expect(llm.getContext()?.isSpeculative()).toBe(false);
    agent.stop();
  });

  it("measures latency from the confirmed turn, not from when preparation started", () => {
    const harness = createDecisionAgent();
    const { agent, llm, tts, turnDetector, clock, ofType } = harness;
    agent.start();
    turnDetector?.emitEagerEnd("hi");
    llm.emitToken("Hello.");
    llm.emitSentence("Hello.", 0);
    tts.emitAudio(audioChunk(1));
    clock.increment(300);
    turnDetector?.emitEnd("hi");
    llm.complete("Hello.");
    tts.complete();

    expect(ofType("ai-turn:ended")[0]?.metrics).toMatchObject({
      timeToFirstToken: 0,
      totalDuration: 0,
    });
    agent.stop();
  });
});
