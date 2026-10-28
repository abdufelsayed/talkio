import { describe, expect, it } from "vitest";
import { SimulatedClock } from "xstate";

import { createAgent } from "../../src";
import {
  createFakeLLM,
  createFakeSTT,
  createFakeTTS,
  createFakeTurnDetector,
  createFakeVAD,
} from "../helpers/fake-providers";

function createTurnDetectorAgent(options: { useVAD: boolean }) {
  const stt = createFakeSTT();
  const vad = options.useVAD ? createFakeVAD() : undefined;
  const turnDetector = createFakeTurnDetector();
  const clock = new SimulatedClock();
  const agent = createAgent({
    stt: stt.provider,
    llm: createFakeLLM().provider,
    tts: createFakeTTS().provider,
    vad: vad?.provider,
    turnDetector: turnDetector.provider,
    simulatedClock: clock,
  });
  return { agent, stt, vad, turnDetector, clock };
}

describe("turn detector speech events", () => {
  it("receives STT speech events when no VAD is configured", () => {
    const { agent, stt, turnDetector, clock } = createTurnDetectorAgent({ useVAD: false });

    agent.start();
    stt.emitSpeechStart();
    clock.increment(320);
    stt.emitSpeechEnd();

    expect(turnDetector.receivedSpeechStarts).toBe(1);
    expect(turnDetector.receivedSpeechEnds).toEqual([320]);
    agent.stop();
  });

  it("receives VAD speech events and ignores STT ones when a VAD is configured", () => {
    const { agent, stt, vad, turnDetector, clock } = createTurnDetectorAgent({ useVAD: true });

    agent.start();
    vad?.emitSpeechStart();
    stt.emitSpeechStart();
    clock.increment(200);
    vad?.emitSpeechEnd(200);
    stt.emitSpeechEnd();

    expect(turnDetector.receivedSpeechStarts).toBe(1);
    expect(turnDetector.receivedSpeechEnds).toEqual([200]);
    agent.stop();
  });
});
