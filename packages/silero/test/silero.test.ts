import { readFileSync } from "node:fs";

import { createAgent, type PublicAgentEvent } from "talkio";
import { describe, expect, it, vi } from "vitest";

import {
  assertNoVADEventsAfterAbort,
  assertVADProviderConformance,
  createFakeLLM,
  createFakeSTT,
  createFakeTTS,
  createVADContextProbe,
} from "@talkio/testkit";

import { silero } from "../src";

const SPEECH = readFileSync(new URL("./fixtures/speech-16k.pcm", import.meta.url));
const SILENCE_SECOND = new Int16Array(16000);

/** One second of silence, the fixture's speech, then one second of silence, in 20 ms chunks. */
function utterance(): ArrayBuffer[] {
  const speech = new Int16Array(SPEECH.buffer, SPEECH.byteOffset, SPEECH.length / 2);
  const samples = new Int16Array(SILENCE_SECOND.length * 2 + speech.length);
  samples.set(speech, SILENCE_SECOND.length);
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < samples.length; offset += 320) {
    chunks.push(samples.slice(offset, offset + 320).buffer);
  }
  return chunks;
}

const speechMs = (SPEECH.length / 2 / 16000) * 1000;

describe("@talkio/silero", () => {
  it("declares the VAD contract", () => {
    assertVADProviderConformance(silero(), { expectedName: "Silero" });
  });

  it("finds the speech in an utterance and reports how long it lasted", async () => {
    const vad = silero();
    const probe = createVADContextProbe();
    vad.start(probe.context);
    for (const chunk of utterance()) vad.sendAudio(chunk);

    await vi.waitFor(() => expect(probe.speechEnds).toHaveLength(1), { timeout: 5000 });
    expect(probe.speechStarts).toBe(1);
    const duration = probe.speechEnds[0]?.duration ?? 0;
    expect(duration).toBeGreaterThan(speechMs * 0.7);
    expect(duration).toBeLessThan(speechMs + 300);
    expect(Math.max(...probe.probabilities)).toBeGreaterThan(0.9);
    expect(probe.errors).toHaveLength(0);
    vad.stop();
  });

  it("stays quiet on silence", async () => {
    const vad = silero();
    const probe = createVADContextProbe();
    vad.start(probe.context);
    for (let index = 0; index < 50; index++) vad.sendAudio(new Int16Array(320).buffer);

    await vi.waitFor(() => expect(probe.probabilities.length).toBeGreaterThanOrEqual(31));
    expect(probe.speechStarts).toBe(0);
    expect(Math.max(...probe.probabilities)).toBeLessThan(0.5);
    vad.stop();
  });

  it("reads 8 kHz mulaw telephony audio", async () => {
    const { linear16ToMulaw, resampleInt16 } = await import("talkio/audio");
    const vad = silero();
    const probe = createVADContextProbe({ audioFormat: { encoding: "mulaw", sampleRate: 8000 } });
    vad.start(probe.context);
    for (const chunk of utterance()) {
      vad.sendAudio(
        linear16ToMulaw(resampleInt16(new Int16Array(chunk), 16000, 8000)).slice().buffer,
      );
    }

    await vi.waitFor(() => expect(probe.speechEnds).toHaveLength(1), { timeout: 5000 });
    expect(probe.speechStarts).toBe(1);
    vad.stop();
  });

  it("reports nothing after its session is aborted", async () => {
    const vad = silero();
    const probe = createVADContextProbe();
    vad.start(probe.context);
    await assertNoVADEventsAfterAbort(probe, async () => {
      for (const chunk of utterance()) vad.sendAudio(chunk);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  });

  it("reports an input format it cannot read", () => {
    const vad = silero();
    const probe = createVADContextProbe({ audioFormat: { encoding: "opus", sampleRate: 48000 } });
    vad.start(probe.context);
    expect(probe.errors.map((error) => error.message)).toEqual([
      "Expected linear16, float32, mulaw or alaw audio, not opus",
    ]);
  });

  it("reports a model it cannot load", async () => {
    const vad = silero({ modelPath: "/nonexistent/silero.onnx" });
    const probe = createVADContextProbe();
    vad.start(probe.context);
    await vi.waitFor(() => expect(probe.errors).toHaveLength(1));
  });

  it("starts the agent's user turn on speech", async () => {
    const events: PublicAgentEvent[] = [];
    const agent = createAgent({
      stt: createFakeSTT().provider,
      llm: createFakeLLM().provider,
      tts: createFakeTTS().provider,
      vad: silero(),
      onEvent: (event) => events.push(event),
    });
    agent.start();
    for (const chunk of utterance()) agent.sendAudio(chunk);

    await vi.waitFor(
      () => expect(events.filter((event) => event.type === "user-turn:started")).toHaveLength(1),
      { timeout: 5000 },
    );
    agent.stop();
  });
});
