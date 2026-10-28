import { describe, expect, it } from "vitest";
import { SimulatedClock } from "xstate";

import { createAgent } from "../../src";
import type { AgentConfig } from "../../src/types/config";
import type { PublicAgentEvent } from "../../src/types/events";
import { audioChunk, createTestAgent } from "../helpers/agent-harness";
import { createFakeLLM, createFakeSTT, createFakeTTS } from "../helpers/fake-providers";

function finishScriptedTurn(harness: ReturnType<typeof createTestAgent>, chunks: number) {
  for (let index = 0; index < chunks; index++) {
    harness.tts.emitAudio(audioChunk(index + 1));
    harness.tts.complete();
  }
}

describe("agent.say", () => {
  it("speaks a greeting without calling the LLM and records it in history", () => {
    const harness = createTestAgent();
    harness.agent.start();
    harness.agent.say("Hi, this is Ava. How can I help?");

    expect(harness.llm.generations).toBe(0);
    expect(harness.ofType("ai-turn:sentence").map((event) => event.sentence)).toEqual([
      "Hi, this is Ava.",
      "How can I help?",
    ]);
    finishScriptedTurn(harness, 2);

    expect(harness.ofType("ai-turn:ended")).toMatchObject([
      { text: "Hi, this is Ava. How can I help?", wasSpoken: true },
    ]);
    expect(harness.agent.getSnapshot().messages).toEqual([
      { role: "assistant", content: "Hi, this is Ava. How can I help?" },
    ]);
    harness.agent.stop();
  });

  it("waits for the current answer to finish", () => {
    const harness = createTestAgent();
    harness.agent.start();
    harness.stt.emitTranscript("hello", true);
    harness.llm.emitSentence("Hello there.", 0);
    harness.agent.say("By the way, we close at six.");
    expect(harness.ofType("ai-turn:started")).toHaveLength(1);

    harness.tts.emitAudio(audioChunk(1));
    harness.tts.complete();
    harness.llm.complete("Hello there.");

    expect(harness.ofType("ai-turn:started")).toHaveLength(2);
    expect(harness.tts.getCurrentRequest()?.text).toBe("By the way, we close at six.");
    harness.agent.stop();
  });

  it("answers a user turn queued during the reply before speaking", () => {
    const harness = createTestAgent({ interruption: false });
    harness.agent.start();
    harness.stt.emitTranscript("hello", true);
    harness.llm.emitSentence("Hello there.", 0);
    harness.tts.emitAudio(audioChunk(1));
    harness.stt.emitTranscript("what are your hours", true);
    harness.agent.say("Also, we close at five.");

    harness.tts.complete();
    harness.llm.complete("Hello there.");
    expect(harness.llm.generations).toBe(2);
    expect(harness.tts.requestedTexts).toEqual(["Hello there."]);

    harness.llm.emitSentence("We open at nine.", 0);
    finishScriptedTurn(harness, 1);
    harness.llm.complete("We open at nine.");
    expect(harness.tts.requestedTexts).toEqual([
      "Hello there.",
      "We open at nine.",
      "Also, we close at five.",
    ]);
    harness.agent.stop();
  });

  it("lets a committing user turn go first", () => {
    const harness = createTestAgent();
    harness.agent.start();
    harness.stt.emitTranscript("what are your hours", false);
    harness.agent.say("One moment.");
    expect(harness.ofType("ai-turn:started")).toHaveLength(0);

    harness.stt.emitTranscript("what are your hours", true);
    expect(harness.llm.generations).toBe(1);
    expect(harness.ofType("ai-turn:interrupted")).toHaveLength(0);
    expect(harness.agent.getSnapshot().messages).toEqual([
      { role: "user", content: "what are your hours" },
    ]);
    harness.agent.stop();
  });
});

function prompts(events: PublicAgentEvent[]) {
  return events.filter((event) => event.type === "silence:detected");
}

describe("silence prompts", () => {
  function createSilentAgent(silence: AgentConfig["silence"]) {
    const stt = createFakeSTT();
    const llm = createFakeLLM();
    const tts = createFakeTTS();
    const clock = new SimulatedClock();
    const events: PublicAgentEvent[] = [];
    const agent = createAgent({
      stt: stt.provider,
      llm: llm.provider,
      tts: tts.provider,
      silence,
      clock,
      onEvent: (event) => events.push(event),
    });
    return { agent, stt, llm, tts, clock, events };
  }

  it("prompts after the user goes quiet, up to maxPrompts, and resets when they speak", () => {
    const { agent, stt, llm, tts, clock, events } = createSilentAgent({
      afterMs: 5000,
      maxPrompts: 2,
      prompt: "Are you still there?",
    });
    agent.start();
    clock.increment(10_000);
    expect(prompts(events)).toHaveLength(0);

    stt.emitTranscript("hello", true);
    llm.emitSentence("Hi.", 0);
    tts.emitAudio(audioChunk(1));
    tts.complete();
    llm.complete("Hi.");
    clock.increment(4999);
    expect(prompts(events)).toHaveLength(0);

    clock.increment(1);
    expect(prompts(events)).toMatchObject([{ promptCount: 1, maxPrompts: 2 }]);
    expect(tts.getCurrentRequest()?.text).toBe("Are you still there?");
    tts.emitAudio(audioChunk(2));
    tts.complete();

    clock.increment(5000);
    expect(prompts(events)).toHaveLength(2);
    tts.emitAudio(audioChunk(3));
    tts.complete();
    clock.increment(20_000);
    expect(prompts(events)).toHaveLength(2);

    stt.emitTranscript("yes I am", true);
    llm.emitSentence("Great.", 0);
    tts.emitAudio(audioChunk(4));
    tts.complete();
    llm.complete("Great.");
    clock.increment(5000);
    expect(prompts(events)).toMatchObject([
      { promptCount: 1 },
      { promptCount: 2 },
      { promptCount: 1 },
    ]);
    agent.stop();
  });

  it("prompts from the start when startMode is always", () => {
    const { agent, clock, events } = createSilentAgent({
      afterMs: 3000,
      startMode: "always",
    });
    agent.start();
    clock.increment(3000);
    expect(prompts(events)).toHaveLength(1);
    agent.stop();
  });

  it.each([undefined, false])(
    "does not watch for silence by default or with false: %s",
    (silence) => {
      const { agent, clock, events } = createSilentAgent(silence);
      agent.start();
      clock.increment(60_000);
      expect(prompts(events)).toHaveLength(0);
      agent.stop();
    },
  );

  it("prompts with the defaults when silence is true", () => {
    const { agent, stt, llm, tts, clock, events } = createSilentAgent(true);
    agent.start();
    stt.emitTranscript("hello", true);
    llm.emitSentence("Hi.", 0);
    tts.emitAudio(audioChunk(1));
    llm.complete("Hi.");
    tts.complete();
    clock.increment(4999);
    expect(prompts(events)).toHaveLength(0);
    clock.increment(1);
    expect(prompts(events)).toHaveLength(1);
    expect(tts.requestedTexts.at(-1)).toBe("Are you still there?");
    agent.stop();
  });
});
