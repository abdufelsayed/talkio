import { describe, expect, it, vi } from "vitest";
import { SimulatedClock, createActor } from "xstate";

import { agentMachine } from "../../src/agent/machine";
import { normalizeFormat } from "../../src/audio/types";
import type { NormalizedAgentConfig } from "../../src/types/config";
import type { PublicAgentEvent } from "../../src/types/events";
import { createFakeLLM, createFakeSTT, createFakeTTS } from "../helpers/fake-providers";

type GuardHarness = {
  actor: ReturnType<typeof createActor>;
  emitted: PublicAgentEvent[];
};

function createGuardHarness(options?: { minDurationMs?: number }): GuardHarness {
  const stt = createFakeSTT();
  const llm = createFakeLLM();
  const tts = createFakeTTS();

  const audio = {
    input: normalizeFormat(stt.provider.metadata.defaultInputFormat),
    output: normalizeFormat(tts.provider.metadata.defaultOutputFormat),
  };

  const config: NormalizedAgentConfig = {
    stt: stt.provider,
    llm: llm.provider,
    tts: tts.provider,
    audio,
    interruption: { enabled: true, minDurationMs: options?.minDurationMs ?? 200 },
  };

  let controller: ReadableStreamDefaultController<ArrayBuffer> | null = null;
  const stream = new ReadableStream<ArrayBuffer>({
    start(streamController) {
      controller = streamController;
    },
  });
  const reader = stream.getReader();
  reader.releaseLock();

  const actor = createActor(agentMachine, {
    input: { config, audioStreamController: controller },
    clock: new SimulatedClock(),
  });

  const emitted: PublicAgentEvent[] = [];
  actor.on("*", (event) => {
    emitted.push(event);
  });

  return { actor, emitted };
}

describe("agent machine guards", () => {
  it("requires minimum STT speech duration before interrupting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { actor, emitted } = createGuardHarness({ minDurationMs: 200 });

    actor.start();
    actor.send({ type: "_agent:start", timestamp: 0 });

    actor.send({ type: "_llm:sentence", sentence: "Hello.", index: 0, timestamp: 0 });
    actor.send({ type: "_stt:speech-start", timestamp: 0 });

    vi.setSystemTime(100);
    actor.send({ type: "_stt:transcript", text: "uh", isFinal: false, timestamp: 100 });

    const interrupted = emitted.find((event) => event.type === "ai-turn:interrupted");
    expect(interrupted).toBeUndefined();

    actor.send({ type: "_stt:speech-end", timestamp: 100 });

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("interrupts once STT speech passes the minimum duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { actor, emitted } = createGuardHarness({ minDurationMs: 200 });

    actor.start();
    actor.send({ type: "_agent:start", timestamp: 0 });

    actor.send({ type: "_llm:sentence", sentence: "Hello.", index: 0, timestamp: 0 });
    actor.send({ type: "_stt:speech-start", timestamp: 0 });

    vi.setSystemTime(250);
    actor.send({ type: "_stt:transcript", text: "interrupt", isFinal: false, timestamp: 250 });

    const interrupted = emitted.find((event) => event.type === "ai-turn:interrupted");
    expect(interrupted).toBeDefined();

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("interrupts an active AI turn on explicit turn end", () => {
    const { actor, emitted } = createGuardHarness({ minDurationMs: 0 });

    actor.start();
    actor.send({ type: "_agent:start", timestamp: 0 });

    actor.send({ type: "_llm:sentence", sentence: "Hello.", index: 0, timestamp: 0 });
    actor.send({ type: "_turn:end", transcript: "hello", timestamp: 10 });

    const interrupted = emitted.find((event) => event.type === "ai-turn:interrupted");
    expect(interrupted).toBeDefined();
  });
});
