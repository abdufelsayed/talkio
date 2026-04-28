import { float32ToLinear16 } from "talkio";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentHarness, createScenario, drainMicrotasks, makeAudioChunk } from "../src";

const audioConfig = {
  input: { encoding: "linear16", sampleRate: 16000, channels: 1 },
  output: { encoding: "linear16", sampleRate: 24000, channels: 1 },
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("@talkio/testkit public agent behavior", () => {
  it("normalizes supported audio input shapes", async () => {
    const harness = createAgentHarness({ audio: audioConfig });
    const { agent, events, stt } = harness;

    agent.start();
    await events.waitForEvent("agent:started");

    const float32 = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const expected = new Int16Array(float32ToLinear16(float32));
    agent.sendAudio(float32);
    expect(new Int16Array(stt.receivedAudio[0])).toEqual(expected);

    const int16 = new Int16Array([1, -2, 3, -4]);
    agent.sendAudio(int16);
    expect(new Int16Array(stt.receivedAudio[1])).toEqual(int16);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    agent.sendAudio(bytes);
    expect(new Uint8Array(stt.receivedAudio[2])).toEqual(bytes);

    const buffer = Buffer.from([5, 6, 7]);
    agent.sendAudio(buffer);
    expect(new Uint8Array(stt.receivedAudio[3])).toEqual(new Uint8Array(buffer));

    expect(() => agent.sendAudio(new Blob([new Uint8Array([1, 2, 3])]))).toThrow(
      "Blob input requires async conversion. Use `await blob.arrayBuffer()` before calling sendAudio()",
    );

    agent.stop();
    await events.waitForEvent("agent:stopped");
  });

  it("waits for turn detector output before ending the human turn", async () => {
    await createScenario({ useTurnDetector: true })
      .start()
      .expectEvent("agent:started")
      .sttPartial("hello")
      .sttFinal("hello")
      .drain()
      .expectNoEvent("human-turn:ended")
      .turnEnd("hello there")
      .expectEvent("human-turn:ended", { transcript: "hello there" })
      .expectEvent("ai-turn:started")
      .llmSentence("Hi.", 0)
      .ttsChunk(1)
      .llmComplete("Hi.")
      .ttsComplete()
      .expectEvent("ai-turn:ended", { wasSpoken: true })
      .stop()
      .expectEvent("agent:stopped")
      .run();
  });

  it("does not end a detector-backed turn on a brief speech end alone", async () => {
    await createScenario({ useTurnDetector: true })
      .start()
      .expectEvent("agent:started")
      .sttPartial("hello")
      .sttFinal("hello")
      .sttSpeechEnd()
      .drain()
      .expectNoEvent("human-turn:ended")
      .stop()
      .expectEvent("agent:stopped")
      .run();
  });

  it("interrupts an active response through VAD and aborts speech synthesis", async () => {
    const result = await createScenario({
      useVAD: true,
      interruption: { enabled: true, minDurationMs: 200 },
    })
      .start()
      .expectEvent("agent:started")
      .sttFinal("hello")
      .expectEvent("ai-turn:started")
      .llmSentence("Hello.", 0)
      .ttsChunk(1, 2)
      .vadSpeechStart()
      .expectEvent("ai-turn:interrupted", { partialText: "" })
      .expectEvent("human-turn:started")
      .drain()
      .stop()
      .expectEvent("agent:stopped")
      .run();

    expect(result.tts.abortedIds.length).toBeGreaterThan(0);
  });

  it("ignores stale filler audio after an LLM-triggered interrupt", async () => {
    const result = await createScenario()
      .start()
      .expectEvent("agent:started")
      .sttFinal("hello")
      .expectEvent("ai-turn:started")
      .llmSay("Hmm...")
      .drain()
      .llmInterrupt()
      .drain()
      .llmSentence("Real answer.", 0)
      .drain()
      .ttsChunk(9, 2)
      .ttsComplete()
      .ttsChunk(7, 2)
      .ttsComplete()
      .llmComplete("Real answer.")
      .expectEvent("ai-turn:ended")
      .stop()
      .expectEvent("agent:stopped")
      .run();

    const audioEvents = result.events.byType("ai-turn:audio");
    expect(audioEvents).toHaveLength(1);
    expect(new Uint8Array(audioEvents[0].audio)).toEqual(new Uint8Array([7, 7]));
  });

  it("requires STT speech to pass the interruption duration threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const harness = createAgentHarness({
      interruption: { enabled: true, minDurationMs: 200 },
    });
    const { agent, events, stt, llm } = harness;

    agent.start();
    await events.waitForEvent("agent:started");

    stt.emitTranscript("hello", true);
    await events.waitForEvent("ai-turn:started");
    llm.emitSentence("Hello.", 0);

    vi.setSystemTime(0);
    stt.emitSpeechStart();
    vi.setSystemTime(100);
    stt.emitTranscript("uh", false);
    expect(events.byType("ai-turn:interrupted")).toHaveLength(0);

    vi.setSystemTime(250);
    stt.emitTranscript("interrupt", false);
    await events.waitForEvent("ai-turn:interrupted");

    agent.stop();
    await events.waitForEvent("agent:stopped");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers from provider errors without corrupting agent state", async () => {
    const vadHarness = createAgentHarness({ useVAD: true });
    vadHarness.agent.start();
    await vadHarness.events.waitForEvent("agent:started");
    vadHarness.vad?.emitError(new Error("vad failed"));
    expect((await vadHarness.events.waitForEvent("agent:error")).source).toBe("vad");
    expect(vadHarness.agent.getSnapshot().isRunning).toBe(true);
    vadHarness.agent.stop();
    await vadHarness.events.waitForEvent("agent:stopped");

    const sttHarness = createAgentHarness();
    sttHarness.agent.start();
    await sttHarness.events.waitForEvent("agent:started");
    sttHarness.stt.emitError(new Error("stt failed"));
    expect((await sttHarness.events.waitForEvent("agent:error")).source).toBe("stt");
    expect(sttHarness.agent.getSnapshot().isRunning).toBe(true);
    sttHarness.agent.stop();
    await sttHarness.events.waitForEvent("agent:stopped");

    const llmHarness = createAgentHarness();
    llmHarness.agent.start();
    await llmHarness.events.waitForEvent("agent:started");
    llmHarness.stt.emitTranscript("hello", true);
    await llmHarness.events.waitForEvent("ai-turn:started");
    llmHarness.llm.error(new Error("llm failed"));
    expect((await llmHarness.events.waitForEvent("agent:error")).source).toBe("llm");
    expect(llmHarness.agent.getSnapshot().isSpeaking).toBe(false);
    llmHarness.agent.stop();
    await llmHarness.events.waitForEvent("agent:stopped");
  });

  it("recovers from TTS errors and continues queued synthesis", async () => {
    const harness = createAgentHarness();
    const { agent, events, stt, llm, tts } = harness;

    agent.start();
    await events.waitForEvent("agent:started");

    stt.emitTranscript("hello", true);
    await events.waitForEvent("ai-turn:started");

    llm.emitSentence("First sentence.", 0);
    llm.emitSentence("Second sentence.", 1);
    tts.emitAudio(makeAudioChunk(2, 2));
    tts.error(new Error("tts failed"));

    expect((await events.waitForEvent("agent:error")).source).toBe("tts");
    await drainMicrotasks();
    expect(tts.requests[0]?.text).toBe("Second sentence.");

    agent.stop();
    await events.waitForEvent("agent:stopped");
  });

  it("emits LLM and TTS timeouts once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const llmHarness = createAgentHarness({ timeout: { llmMs: 10 } });
    llmHarness.agent.start();
    await llmHarness.events.waitForEvent("agent:started");
    llmHarness.stt.emitTranscript("hello", true);
    await llmHarness.events.waitForEvent("ai-turn:started");

    vi.advanceTimersByTime(20);
    await drainMicrotasks();
    expect((await llmHarness.events.waitForEvent("agent:error")).source).toBe("llm");
    llmHarness.llm.error(new Error("late llm error"));
    await drainMicrotasks();
    expect(llmHarness.events.byType("agent:error")).toHaveLength(1);
    llmHarness.agent.stop();
    await llmHarness.events.waitForEvent("agent:stopped");

    vi.setSystemTime(0);
    const ttsHarness = createAgentHarness({ timeout: { ttsMs: 10 } });
    ttsHarness.agent.start();
    await ttsHarness.events.waitForEvent("agent:started");
    ttsHarness.stt.emitTranscript("hello", true);
    await ttsHarness.events.waitForEvent("ai-turn:started");
    ttsHarness.llm.emitSentence("Hello.", 0);

    vi.advanceTimersByTime(20);
    await drainMicrotasks();
    expect((await ttsHarness.events.waitForEvent("agent:error")).source).toBe("tts");
    ttsHarness.tts.error(new Error("late tts error"));
    await drainMicrotasks();
    expect(ttsHarness.events.byType("agent:error")).toHaveLength(1);
    ttsHarness.agent.stop();
    await ttsHarness.events.waitForEvent("agent:stopped");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts active providers when stopped", async () => {
    const listening = createAgentHarness({ useVAD: true, useTurnDetector: true });
    listening.agent.start();
    await listening.events.waitForEvent("agent:started");
    listening.agent.stop();
    await listening.events.waitForEvent("agent:stopped");
    expect(listening.stt.aborted).toBe(true);
    expect(listening.vad?.aborted).toBe(true);
    expect(listening.turnDetector?.aborted).toBe(true);

    const generating = createAgentHarness();
    generating.agent.start();
    await generating.events.waitForEvent("agent:started");
    generating.stt.emitTranscript("hello", true);
    await generating.events.waitForEvent("ai-turn:started");
    generating.agent.stop();
    await generating.events.waitForEvent("agent:stopped");
    expect(generating.llm.aborted).toBe(true);

    const speaking = createAgentHarness();
    speaking.agent.start();
    await speaking.events.waitForEvent("agent:started");
    speaking.stt.emitTranscript("hello", true);
    await speaking.events.waitForEvent("ai-turn:started");
    speaking.llm.emitSentence("Hello.", 0);
    speaking.tts.emitAudio(makeAudioChunk(new Uint8Array([1, 2])));
    speaking.agent.stop();
    await speaking.events.waitForEvent("agent:stopped");
    expect(speaking.tts.abortedIds.length).toBeGreaterThan(0);
  });

  it("handles idempotent lifecycle calls and ignored pre-start audio", async () => {
    const audioHarness = createAgentHarness();
    audioHarness.agent.sendAudio(new Uint8Array([1, 2, 3]));
    audioHarness.agent.start();
    await audioHarness.events.waitForEvent("agent:started");
    await drainMicrotasks();
    expect(audioHarness.stt.receivedAudio).toHaveLength(0);
    audioHarness.agent.stop();
    await audioHarness.events.waitForEvent("agent:stopped");

    const lifecycleHarness = createAgentHarness();
    lifecycleHarness.agent.start();
    await lifecycleHarness.events.waitForEvent("agent:started");
    lifecycleHarness.agent.start();
    expect(lifecycleHarness.events.byType("agent:started")).toHaveLength(1);
    lifecycleHarness.agent.stop();
    await lifecycleHarness.events.waitForEvent("agent:stopped");
    lifecycleHarness.agent.stop();
    expect(lifecycleHarness.events.byType("agent:stopped")).toHaveLength(1);
  });

  it("handles empty transcripts, long responses, and rapid user turns", async () => {
    await createScenario()
      .start()
      .expectEvent("agent:started")
      .sttFinal("")
      .expectEvent("human-turn:ended", { transcript: "" })
      .stop()
      .expectEvent("agent:stopped")
      .run();

    const longResponse = createAgentHarness();
    longResponse.agent.start();
    await longResponse.events.waitForEvent("agent:started");
    longResponse.stt.emitTranscript("hello", true);
    await longResponse.events.waitForEvent("ai-turn:started");

    const sentences = ["One.", "Two.", "Three.", "Four.", "Five."];
    sentences.forEach((sentence, index) => {
      longResponse.llm.emitSentence(sentence, index);
    });

    for (const sentence of sentences) {
      expect(longResponse.tts.getCurrentRequest()?.text).toBe(sentence);
      longResponse.tts.emitAudio(makeAudioChunk(sentence.length));
      longResponse.tts.complete();
    }

    longResponse.llm.complete(sentences.join(" "));
    await longResponse.events.waitForEvent("ai-turn:ended");
    longResponse.agent.stop();
    await longResponse.events.waitForEvent("agent:stopped");

    const rapid = createAgentHarness();
    rapid.agent.start();
    await rapid.events.waitForEvent("agent:started");
    rapid.stt.emitTranscript("first", true);
    await rapid.events.waitForEvent("ai-turn:started");
    rapid.llm.emitSentence("First response.", 0);
    rapid.tts.emitAudio(makeAudioChunk(1));
    rapid.stt.emitTranscript("second", true);
    await rapid.events.waitForEvent("ai-turn:interrupted");
    await rapid.events.waitForEvent("ai-turn:started", { fromIndex: 1 });
    rapid.llm.emitSentence("Second response.", 0);
    rapid.tts.emitAudio(makeAudioChunk(2));
    rapid.llm.complete("Second response.");
    rapid.tts.complete();
    await rapid.events.waitForEvent("ai-turn:ended");
    rapid.agent.stop();
    await rapid.events.waitForEvent("agent:stopped");
  });

  it("handles slow audio consumers without losing output events", async () => {
    const result = await createScenario()
      .start()
      .expectEvent("agent:started")
      .sttFinal("hello")
      .expectEvent("ai-turn:started")
      .llmSentence("Hello.", 0)
      .ttsChunk(1, 2)
      .ttsChunk(2, 2)
      .ttsChunk(3, 2)
      .llmComplete("Hello.")
      .ttsComplete()
      .expectEvent("ai-turn:ended")
      .stop()
      .expectEvent("agent:stopped")
      .run();

    expect(result.events.byType("ai-turn:audio")).toHaveLength(3);
  });

  it("tracks completed, interrupted, and error metrics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const completed = createAgentHarness();
    completed.agent.start();
    await completed.events.waitForEvent("agent:started");

    vi.setSystemTime(100);
    completed.stt.emitTranscript("hello", false);
    vi.setSystemTime(200);
    completed.stt.emitTranscript("hello", true);
    await completed.events.waitForEvent("ai-turn:started");
    vi.setSystemTime(260);
    completed.llm.emitToken("Hi");
    vi.setSystemTime(300);
    completed.llm.emitSentence("Hi.", 0);
    vi.setSystemTime(350);
    completed.tts.emitAudio(makeAudioChunk(3, 3));
    vi.setSystemTime(400);
    completed.llm.complete("Hi.");
    vi.setSystemTime(500);
    completed.tts.complete();

    const aiEnded = await completed.events.waitForEvent("ai-turn:ended");
    expect(aiEnded.metrics.timeToFirstToken).toBe(60);
    expect(aiEnded.metrics.timeToFirstSentence).toBe(40);
    expect(aiEnded.metrics.timeToFirstAudio).toBe(50);
    expect(aiEnded.metrics.totalDuration).toBe(300);
    expect(aiEnded.metrics.tokenCount).toBe(1);
    expect(aiEnded.metrics.sentenceCount).toBe(1);
    expect(completed.agent.getSnapshot().metrics.turns.completed).toBe(1);
    completed.agent.stop();
    await completed.events.waitForEvent("agent:stopped");

    const interrupted = createAgentHarness({
      useVAD: true,
      interruption: { enabled: true },
    });
    interrupted.agent.start();
    await interrupted.events.waitForEvent("agent:started");
    interrupted.stt.emitTranscript("hello", true);
    await interrupted.events.waitForEvent("ai-turn:started");
    interrupted.llm.emitSentence("Hello.", 0);
    interrupted.tts.emitAudio(makeAudioChunk(4, 3));
    interrupted.vad?.emitSpeechStart();
    await interrupted.events.waitForEvent("ai-turn:interrupted");
    interrupted.stt.emitError(new Error("stt issue"));
    await interrupted.events.waitForEvent("agent:error");
    expect(interrupted.agent.getSnapshot().metrics.turns.interrupted).toBeGreaterThanOrEqual(1);
    expect(interrupted.agent.getSnapshot().metrics.errors.total).toBeGreaterThanOrEqual(1);
    interrupted.agent.stop();
    await interrupted.events.waitForEvent("agent:stopped");

    expect(vi.getTimerCount()).toBe(0);
  });
});
