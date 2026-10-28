import { readFileSync } from "node:fs";

import { createAgent, type PublicAgentEvent } from "talkio";
import { describe, expect, it, vi } from "vitest";

import {
  assertTurnDetectorConformance,
  createFakeLLM,
  createFakeSTT,
  createFakeTTS,
  createFakeVAD,
  createTurnDetectorContextProbe,
} from "@talkio/testkit";

import { smartTurn } from "../src";

/** An utterance followed by the 200 ms of silence a VAD waits before calling it a pause. */
function utterance(name: "complete" | "incomplete"): ArrayBuffer {
  const speech = readFileSync(new URL(`./fixtures/${name}-16k.pcm`, import.meta.url));
  const audio = new Uint8Array(speech.length + 6400);
  audio.set(speech);
  return audio.buffer;
}

async function score(name: "complete" | "incomplete") {
  const detector = smartTurn();
  const probe = createTurnDetectorContextProbe();
  await detector.start?.(probe.context);
  detector.sendAudio?.(utterance(name));
  const probability = await detector.onPause?.(probe.pause(""));
  detector.stop?.();
  return probability;
}

describe("@talkio/smart-turn", () => {
  it("declares the turn detector contract", () => {
    assertTurnDetectorConformance(smartTurn(), { expectedName: "SmartTurn" });
    expect(smartTurn().output).toBe("probability");
  });

  it("hears that a finished question is finished", async () => {
    expect(await score("complete")).toBeGreaterThan(0.8);
  });

  it("hears that a sentence trailing off is not", async () => {
    expect(await score("incomplete")).toBeLessThan(0.2);
  });

  it("scores the same audio the same however it arrives", async () => {
    const audio = new Uint8Array(utterance("complete"));
    const detector = smartTurn();
    const probe = createTurnDetectorContextProbe();
    await detector.start?.(probe.context);
    for (let offset = 0; offset < audio.length; offset += 641) {
      detector.sendAudio?.(audio.slice(offset, offset + 641).buffer);
    }
    expect(await detector.onPause?.(probe.pause(""))).toBeCloseTo(
      (await score("complete")) ?? 0,
      5,
    );
  });

  it("keeps only the last eight seconds", async () => {
    const detector = smartTurn();
    const probe = createTurnDetectorContextProbe();
    await detector.start?.(probe.context);
    const before = new Uint8Array(utterance("incomplete"));
    const after = new Uint8Array(utterance("complete"));
    const long = new Uint8Array(before.length + 16000 * 2 * 9 + after.length);
    long.set(before);
    long.set(after, long.length - after.length);
    detector.sendAudio?.(long.buffer);
    expect(await detector.onPause?.(probe.pause(""))).toBeCloseTo(
      (await score("complete")) ?? 0,
      5,
    );
  });

  it("does not score before it has heard anything, or once the pause is over", async () => {
    const detector = smartTurn();
    const probe = createTurnDetectorContextProbe();
    await detector.start?.(probe.context);
    expect(await detector.onPause?.(probe.pause(""))).toBeUndefined();

    detector.sendAudio?.(utterance("complete"));
    const pause = probe.pause("");
    probe.abort();
    expect(await detector.onPause?.(pause)).toBeUndefined();
  });

  it("reads 8 kHz mulaw telephony audio", async () => {
    const { linear16ToMulaw, resampleInt16 } = await import("talkio/audio");
    const detector = smartTurn();
    const probe = createTurnDetectorContextProbe({
      audioFormat: { encoding: "mulaw", sampleRate: 8000 },
    });
    await detector.start?.(probe.context);
    const pcm = new Int16Array(utterance("complete"));
    detector.sendAudio?.(linear16ToMulaw(resampleInt16(pcm, 16000, 8000)).slice().buffer);
    expect(await detector.onPause?.(probe.pause(""))).toBeGreaterThan(0.8);
  });

  it("fails to start without its model", async () => {
    const detector = smartTurn({ modelPath: "/nonexistent/smart-turn.onnx" });
    await expect(detector.start?.(createTurnDetectorContextProbe().context)).rejects.toThrow();
  });

  it.each([
    { name: "complete", ends: true },
    { name: "incomplete", ends: false },
  ] as const)(
    "lets the agent answer quickly only when the user sounds done: $name",
    async ({ name, ends }) => {
      const stt = createFakeSTT();
      const vad = createFakeVAD();
      const events: PublicAgentEvent[] = [];
      const agent = createAgent({
        stt: stt.provider,
        llm: createFakeLLM().provider,
        tts: createFakeTTS().provider,
        vad: vad.provider,
        turnDetector: smartTurn(),
        turnTaking: { minDelayMs: 100, maxDelayMs: 3000 },
        onEvent: (event) => events.push(event),
      });
      agent.start();
      const ended = () => events.filter((event) => event.type === "user-turn:ended");

      vad.emitSpeechStart();
      agent.sendAudio(utterance(name));
      stt.emitTranscript("can you book me a table", true);
      vad.emitSpeechEnd();

      if (ends) {
        await vi.waitFor(() => expect(ended()).toHaveLength(1), { timeout: 2000 });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(ended()).toHaveLength(0);
      }
      expect(events.filter((event) => event.type === "agent:error")).toHaveLength(0);
      agent.stop();
    },
  );
});
