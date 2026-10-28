import { describe, expect, it } from "vitest";
import { SimulatedClock } from "xstate";

import { createAgent } from "../../src";
import type { PublicAgentEvent } from "../../src/types/events";
import { createTestAgent, type TestAgentOptions } from "../helpers/agent-harness";
import { createFakeLLM, createFakeSTT, createFakeTTS } from "../helpers/fake-providers";

const BYTES_PER_MS = 48;

/** Linear16 audio at the fake TTS's 24 kHz mono default. */
function audioMs(ms: number, fill = 1): ArrayBuffer {
  return new Uint8Array(ms * BYTES_PER_MS).fill(fill).buffer;
}

function speak(options: TestAgentOptions & { sentence?: string; ms?: number } = {}) {
  const harness = createTestAgent({ vad: true, ...options });
  const sentence = options.sentence ?? "One two three four five.";
  harness.agent.start();
  harness.stt.emitTranscript("hello", true);
  harness.llm.emitSentence(sentence, 0);
  harness.tts.emitAudio(audioMs(options.ms ?? 1000));
  return harness;
}

function finishSynthesis(harness: ReturnType<typeof speak>, text = "One two three four five.") {
  harness.llm.complete(text);
  harness.tts.complete();
}

describe("playback tracking", () => {
  it("ends the AI turn when its audio has played, not when synthesis finished", () => {
    const harness = speak();
    finishSynthesis(harness);

    expect(harness.ofType("ai-turn:ended")).toHaveLength(0);
    expect(harness.agent.getSnapshot().isSpeaking).toBe(true);
    harness.clock.increment(999);
    expect(harness.ofType("ai-turn:ended")).toHaveLength(0);
    harness.clock.increment(1);
    expect(harness.ofType("ai-turn:ended")).toMatchObject([{ wasSpoken: true }]);
    expect(harness.agent.getSnapshot().isSpeaking).toBe(false);
    harness.agent.stop();
  });

  it("treats speech during the playout tail as an interruption and keeps only what was heard", () => {
    const harness = speak();
    finishSynthesis(harness);
    harness.clock.increment(400);

    harness.vad?.emitSpeechStart();
    expect(harness.ofType("audio:pause")).toHaveLength(1);
    expect(harness.ofType("human-turn:started")).toHaveLength(1);
    harness.clock.increment(200);
    harness.stt.emitTranscript("wait a second", false);

    expect(harness.ofType("ai-turn:interrupted")).toMatchObject([
      { heardText: "One two", audioCompletedText: "One two three four five." },
    ]);
    expect(harness.agent.getSnapshot().messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "One two" },
    ]);
    harness.agent.stop();
  });

  it("cuts heard text at the last finished word when TTS reports word timings", () => {
    const harness = speak();
    harness.tts.emitWordTimings([
      { word: "One", startMs: 0, endMs: 120 },
      { word: "two", startMs: 120, endMs: 300 },
      { word: "three", startMs: 300, endMs: 480 },
    ]);
    harness.clock.increment(470);

    harness.vad?.emitSpeechStart();
    harness.clock.increment(200);
    harness.stt.emitTranscript("wait a second", false);
    expect(harness.ofType("ai-turn:interrupted")[0]?.heardText).toBe("One two");
    harness.agent.stop();
  });

  it("does not advance the estimate while the listener waits for audio", () => {
    const harness = speak({ sentence: "First sentence here.", ms: 300 });
    harness.tts.complete();
    harness.llm.emitSentence("Second one is longer now.", 1);
    harness.clock.increment(1000);
    harness.tts.emitAudio(audioMs(500));
    harness.tts.complete();
    harness.clock.increment(250);

    harness.vad?.emitSpeechStart();
    harness.clock.increment(200);
    harness.stt.emitTranscript("wait a second", false);
    expect(harness.ofType("ai-turn:interrupted")[0]?.heardText).toBe(
      "First sentence here. Second one",
    );
    harness.agent.stop();
  });

  it("freezes the playhead while paused, so a false start delays the end of the turn", () => {
    const harness = speak();
    finishSynthesis(harness);
    harness.clock.increment(300);
    harness.vad?.emitSpeechStart();
    harness.clock.increment(80);
    harness.vad?.emitSpeechEnd(80);

    harness.clock.increment(699);
    expect(harness.ofType("ai-turn:ended")).toHaveLength(0);
    harness.clock.increment(1);
    expect(harness.ofType("ai-turn:ended")).toHaveLength(1);
    harness.agent.stop();
  });

  it("uses playback reports from the client instead of the estimate", () => {
    const harness = speak();
    finishSynthesis(harness);
    harness.clock.increment(500);
    const turnId = harness.ofType("ai-turn:started")[0]?.turnId ?? "";
    harness.agent.reportPlayback({ turnId, playedMs: 100 });

    harness.clock.increment(500);
    expect(harness.ofType("ai-turn:ended")).toHaveLength(0);
    harness.clock.increment(400);
    expect(harness.ofType("ai-turn:ended")).toHaveLength(1);
    harness.agent.stop();
  });

  it("delays the estimate by the configured output latency", () => {
    const latency = speak({ playback: { outputLatencyMs: 200 } });
    latency.tts.complete();
    latency.clock.increment(400);
    latency.vad?.emitSpeechStart();
    latency.clock.increment(200);
    latency.stt.emitTranscript("wait a second", false);
    expect(latency.ofType("ai-turn:interrupted")[0]?.heardText).toBe("One");
    latency.agent.stop();
  });

  it("replays audio the listener dropped when a cleared interruption is cancelled", () => {
    const harness = speak({ interruption: { pendingAudio: "clear" } });
    harness.clock.increment(400);
    harness.vad?.emitSpeechStart();
    expect(harness.ofType("audio:clear")).toHaveLength(1);
    harness.clock.increment(80);
    harness.vad?.emitSpeechEnd(80);

    expect(harness.ofType("audio:resume")).toHaveLength(1);
    const audio = harness.ofType("ai-turn:audio");
    expect(audio).toHaveLength(2);
    expect(audio[1]?.audio.byteLength).toBe(600 * BYTES_PER_MS);
    harness.agent.stop();
  });
});

describe("playback with compressed output", () => {
  it("ends the turn when synthesis finishes and keeps completed text", () => {
    const stt = createFakeSTT();
    const llm = createFakeLLM();
    const mp3 = { encoding: "mp3", sampleRate: 44100, channels: 2 } as const;
    const tts = createFakeTTS({ supportedOutputFormats: [mp3], defaultOutputFormat: mp3 });
    const events: PublicAgentEvent[] = [];
    const agent = createAgent({
      stt: stt.provider,
      llm: llm.provider,
      tts: tts.provider,
      simulatedClock: new SimulatedClock(),
      onEvent: (event) => events.push(event),
    });
    agent.start();
    stt.emitTranscript("hello", true);
    llm.emitSentence("Compressed audio.", 0);
    tts.emitAudio(new Uint8Array(4096).buffer);
    llm.complete("Compressed audio.");
    tts.complete();

    expect(events.filter((event) => event.type === "ai-turn:ended")).toHaveLength(1);
    agent.stop();
  });
});
