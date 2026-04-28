import { describe, expect, it, vi } from "vitest";

import { createAgentHarness, drainMicrotasks } from "../helpers/harness";

function makeAudioChunk(value: number): ArrayBuffer {
  return new Uint8Array([value, value]).buffer;
}

describe("error recovery", () => {
  it("emits VAD error and continues running", async () => {
    const harness = createAgentHarness({ useVAD: true });
    const { agent, events, vad } = harness;

    agent.start();
    await events.waitForEvent("agent:started");

    vad?.emitError(new Error("vad failed"));
    const errorEvent = await events.waitForEvent("agent:error");
    expect(errorEvent.source).toBe("vad");

    const snapshot = agent.getSnapshot();
    expect(snapshot.isRunning).toBe(true);

    agent.stop();
    await events.waitForEvent("agent:stopped");
  });

  it("emits STT error and continues running", async () => {
    const harness = createAgentHarness();
    const { agent, events, stt } = harness;

    agent.start();
    await events.waitForEvent("agent:started");

    stt.emitError(new Error("stt failed"));
    const errorEvent = await events.waitForEvent("agent:error");
    expect(errorEvent.source).toBe("stt");

    const snapshot = agent.getSnapshot();
    expect(snapshot.isRunning).toBe(true);

    agent.stop();
    await events.waitForEvent("agent:stopped");
  });

  it("emits LLM error and resets turn state", async () => {
    const harness = createAgentHarness();
    const { agent, events, stt, llm } = harness;

    agent.start();
    await events.waitForEvent("agent:started");

    stt.emitTranscript("hello", true);
    await events.waitForEvent("ai-turn:started");

    llm.error(new Error("llm failed"));
    const errorEvent = await events.waitForEvent("agent:error");
    expect(errorEvent.source).toBe("llm");

    const snapshot = agent.getSnapshot();
    expect(snapshot.isSpeaking).toBe(false);

    agent.stop();
    await events.waitForEvent("agent:stopped");
  });

  it("recovers from TTS error and continues queue", async () => {
    const harness = createAgentHarness();
    const { agent, events, stt, llm, tts } = harness;

    agent.start();
    await events.waitForEvent("agent:started");

    stt.emitTranscript("hello", true);
    await events.waitForEvent("ai-turn:started");

    llm.emitSentence("First sentence.", 0);
    llm.emitSentence("Second sentence.", 1);

    tts.emitAudio(makeAudioChunk(2));
    tts.error(new Error("tts failed"));

    const errorEvent = await events.waitForEvent("agent:error");
    expect(errorEvent.source).toBe("tts");

    await drainMicrotasks();
    expect(tts.requests[0]?.text).toBe("Second sentence.");

    agent.stop();
    await events.waitForEvent("agent:stopped");
  });

  it("emits LLM timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const harness = createAgentHarness({ timeout: { llmMs: 10 } });
    const { agent, events, stt, llm } = harness;

    agent.start();
    await events.waitForEvent("agent:started");

    stt.emitTranscript("hello", true);
    await events.waitForEvent("ai-turn:started");

    vi.advanceTimersByTime(20);
    await drainMicrotasks();

    const errorEvent = await events.waitForEvent("agent:error");
    expect(errorEvent.source).toBe("llm");
    llm.error(new Error("late llm error"));
    await drainMicrotasks();
    expect(events.byType("agent:error")).toHaveLength(1);

    agent.stop();
    await events.waitForEvent("agent:stopped");

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("emits TTS timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const harness = createAgentHarness({ timeout: { ttsMs: 10 } });
    const { agent, events, stt, llm, tts } = harness;

    agent.start();
    await events.waitForEvent("agent:started");

    stt.emitTranscript("hello", true);
    await events.waitForEvent("ai-turn:started");

    llm.emitSentence("Hello.", 0);

    vi.advanceTimersByTime(20);
    await drainMicrotasks();

    const errorEvent = await events.waitForEvent("agent:error");
    expect(errorEvent.source).toBe("tts");
    tts.error(new Error("late tts error"));
    await drainMicrotasks();
    expect(events.byType("agent:error")).toHaveLength(1);

    agent.stop();
    await events.waitForEvent("agent:stopped");

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
