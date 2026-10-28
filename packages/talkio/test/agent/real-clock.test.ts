import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgent } from "../../src";
import type { PublicAgentEvent } from "../../src/types/events";
import {
  createFakeLLM,
  createFakeSTT,
  createFakeTTS,
  createFakeVAD,
} from "../helpers/fake-providers";

afterEach(() => {
  vi.useRealTimers();
});

describe("agents without a simulated clock", () => {
  it("runs delayed transitions on the real timer", () => {
    vi.useFakeTimers();
    const stt = createFakeSTT();
    const llm = createFakeLLM();
    const tts = createFakeTTS();
    const vad = createFakeVAD();
    const events: PublicAgentEvent[] = [];
    const agent = createAgent({
      stt: stt.provider,
      llm: llm.provider,
      tts: tts.provider,
      vad: vad.provider,
      onEvent: (event) => events.push(event),
    });

    agent.start();
    stt.emitTranscript("hello", true);
    llm.emitSentence("Hello there.", 0);
    tts.emitAudio(new Uint8Array([1]).buffer);
    vad.emitSpeechStart();
    vi.advanceTimersByTime(250);
    stt.emitTranscript("wait a second", false);

    expect(events.some((event) => event.type === "ai-turn:interrupted")).toBe(true);
    agent.stop();
  });
});
