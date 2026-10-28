import { describe, expect, it } from "vitest";
import { SimulatedClock } from "xstate";

import { createAgent } from "../../src";
import type { AgentTraceEvent, PublicAgentEvent } from "../../src/types/events";
import {
  createFakeLLM,
  createFakeSTT,
  createFakeTTS,
  createFakeVAD,
  type FakeLLM,
  type FakeSTT,
  type FakeTTS,
  type FakeVAD,
} from "../helpers/fake-providers";

type Harness = {
  agent: ReturnType<typeof createAgent>;
  stt: FakeSTT;
  llm: FakeLLM;
  tts: FakeTTS;
  vad: FakeVAD;
  clock: SimulatedClock;
  events: PublicAgentEvent[];
  traces: AgentTraceEvent[];
};

function createLifecycleHarness(): Harness {
  const stt = createFakeSTT();
  const llm = createFakeLLM();
  const tts = createFakeTTS();
  const vad = createFakeVAD();
  const clock = new SimulatedClock();
  const events: PublicAgentEvent[] = [];
  const traces: AgentTraceEvent[] = [];

  const agent = createAgent({
    stt: stt.provider,
    llm: llm.provider,
    tts: tts.provider,
    vad: vad.provider,
    interruption: { enabled: true, minDurationMs: 200 },
    simulatedClock: clock,
    observability: {
      level: "trace",
      onTrace: (event) => traces.push(event),
    },
    onEvent: (event) => events.push(event),
  });

  return { agent, stt, llm, tts, vad, clock, events, traces };
}

function completeHumanTurn(harness: Harness): void {
  harness.agent.start();
  harness.stt.emitTranscript("hello", true);
}

describe("AI turn lifecycle", () => {
  it("waits for TTS completion when the LLM completes first", () => {
    const harness = createLifecycleHarness();
    const { agent, events, llm, tts } = harness;

    completeHumanTurn(harness);
    expect(events.filter((event) => event.type === "ai-turn:started")).toHaveLength(1);

    llm.emitToken("Hello.");
    llm.emitSentence("Hello.", 0);
    llm.complete("Hello.");
    expect(events.filter((event) => event.type === "ai-turn:ended")).toHaveLength(0);

    tts.emitAudio(new Uint8Array([1, 2]).buffer);
    expect(events.filter((event) => event.type === "ai-turn:ended")).toHaveLength(0);

    tts.complete();
    const ended = events.find((event) => event.type === "ai-turn:ended");
    expect(ended).toMatchObject({ type: "ai-turn:ended", text: "Hello.", wasSpoken: true });
    expect(agent.getSnapshot().messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello." },
    ]);
    agent.stop();
  });

  it("waits for LLM completion when TTS finishes first", () => {
    const harness = createLifecycleHarness();
    const { agent, events, llm, tts } = harness;

    completeHumanTurn(harness);
    llm.emitSentence("Hello.", 0);
    tts.emitAudio(new Uint8Array([1]).buffer);
    tts.complete();
    expect(events.filter((event) => event.type === "ai-turn:ended")).toHaveLength(0);

    llm.complete("Hello.");
    const endedEvents = events.filter((event) => event.type === "ai-turn:ended");
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]).toMatchObject({ text: "Hello.", wasSpoken: true });
    agent.stop();
  });

  it("does not commit a full assistant message when interrupted after LLM completion", () => {
    const harness = createLifecycleHarness();
    const { agent, clock, events, llm, tts, vad } = harness;

    completeHumanTurn(harness);
    llm.emitToken("Long answer.");
    llm.emitSentence("Long answer.", 0);
    llm.complete("Long answer.");
    tts.emitAudio(new Uint8Array([1]).buffer);

    vad.emitSpeechStart();
    clock.increment(200);
    harness.stt.emitTranscript("wait a second", false);

    const interrupted = events.find((event) => event.type === "ai-turn:interrupted");
    expect(interrupted).toMatchObject({
      type: "ai-turn:interrupted",
      partialText: "Long answer.",
      generatedText: "Long answer.",
      audioStartedText: "Long answer.",
      audioCompletedText: "",
      spokenText: "",
    });
    expect(events.filter((event) => event.type === "ai-turn:ended")).toHaveLength(0);
    expect(agent.getSnapshot().messages).toEqual([{ role: "user", content: "hello" }]);
    agent.stop();
  });

  it("separates generated and spoken text when interrupted before audio", () => {
    const harness = createLifecycleHarness();
    const { agent, clock, events, llm, vad } = harness;

    completeHumanTurn(harness);
    llm.emitToken("Long answer.");
    llm.emitSentence("Long answer.", 0);
    llm.complete("Long answer.");

    vad.emitSpeechStart();
    clock.increment(200);
    harness.stt.emitTranscript("wait a second", false);

    const interrupted = events.find((event) => event.type === "ai-turn:interrupted");
    expect(interrupted).toMatchObject({
      type: "ai-turn:interrupted",
      partialText: "Long answer.",
      generatedText: "Long answer.",
      audioStartedText: "",
      audioCompletedText: "",
      spokenText: "",
    });
    agent.stop();
  });

  it("reports completed audio text only after TTS completion", () => {
    const harness = createLifecycleHarness();
    const { agent, clock, events, llm, tts, vad } = harness;

    completeHumanTurn(harness);
    llm.emitToken("First. Second.");
    llm.emitSentence("First.", 0);
    tts.emitAudio(new Uint8Array([1]).buffer);
    tts.complete();
    llm.emitSentence("Second.", 1);
    tts.emitAudio(new Uint8Array([2]).buffer);
    llm.complete("First. Second.");

    vad.emitSpeechStart();
    clock.increment(200);
    harness.stt.emitTranscript("wait a second", false);

    const interrupted = events.find((event) => event.type === "ai-turn:interrupted");
    expect(interrupted).toMatchObject({
      type: "ai-turn:interrupted",
      generatedText: "First. Second.",
      audioStartedText: "First. Second.",
      audioCompletedText: "First.",
      spokenText: "First.",
    });
    expect(agent.getSnapshot().messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "First." },
    ]);
    agent.stop();
  });

  it("emits the first TTS chunk to the audio stream immediately", async () => {
    const harness = createLifecycleHarness();
    const { agent, llm, tts } = harness;
    const reader = agent.audioStream.getReader();

    completeHumanTurn(harness);
    llm.emitSentence("Hello.", 0);

    const audio = new Uint8Array([7, 8]).buffer;
    const read = reader.read();
    tts.emitAudio(audio);

    const result = await read;
    expect(result.done).toBe(false);
    expect(result.value).toBe(audio);
    reader.releaseLock();
    agent.stop();
  });

  it("continues the same AI turn when a speculative interruption is cancelled", () => {
    const harness = createLifecycleHarness();
    const { agent, clock, events, llm, tts, vad } = harness;

    completeHumanTurn(harness);
    llm.emitToken("Keep going.");
    llm.emitSentence("Keep going.", 0);
    tts.emitAudio(new Uint8Array([1]).buffer);

    vad.emitSpeechStart();
    expect(events.filter((event) => event.type === "ai-turn:interruption-pending")).toHaveLength(1);

    clock.increment(80);
    vad.emitSpeechEnd(80);

    expect(events.filter((event) => event.type === "ai-turn:interruption-cancelled")).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === "ai-turn:interrupted")).toHaveLength(0);

    llm.complete("Keep going.");
    tts.complete();

    const ended = events.find((event) => event.type === "ai-turn:ended");
    expect(ended).toMatchObject({ text: "Keep going.", wasSpoken: true });
    expect(agent.getSnapshot().messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Keep going." },
    ]);
    agent.stop();
  });

  it("emits trace events with session and turn identifiers", () => {
    const harness = createLifecycleHarness();
    const { agent, llm, traces, tts } = harness;

    completeHumanTurn(harness);
    llm.emitToken("Hi.");
    llm.emitSentence("Hi.", 0);
    tts.emitAudio(new Uint8Array([3]).buffer);
    llm.complete("Hi.");
    tts.complete();

    expect(traces.every((event) => event.sessionId === agent.id)).toBe(true);
    expect(traces.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "agent:started",
        "human-turn:ended",
        "ai-turn:started",
        "llm:first-token",
        "tts:first-audio",
        "audio:send",
        "ai-turn:ended",
      ]),
    );

    const aiTurnStarted = traces.find((event) => event.type === "ai-turn:started");
    const llmFirstToken = traces.find((event) => event.type === "llm:first-token");
    const ttsFirstAudio = traces.find((event) => event.type === "tts:first-audio");
    expect(aiTurnStarted?.turnId).toBeTruthy();
    expect(llmFirstToken?.turnId).toBe(aiTurnStarted?.turnId);
    expect(ttsFirstAudio?.turnId).toBe(aiTurnStarted?.turnId);
    agent.stop();
  });
});
