import { describe, expect, it } from "vitest";

import {
  assertNoLLMEventsAfterAbort,
  assertNoSTTEventsAfterAbort,
  assertNoTTSEventsAfterAbort,
  assertNoTurnDetectorEventsAfterAbort,
  assertTurnDetectorProviderConformance,
  createFakeTurnDetector,
  createLLMContextProbe,
  createSTTContextProbe,
  createTTSContextProbe,
  createTurnDetectorContextProbe,
  ScenarioAssertionError,
  snapshotLLMContextProbe,
  snapshotTurnDetectorContextProbe,
} from "../src";

describe("@talkio/testkit provider conformance probes", () => {
  it("snapshots provider context emissions", () => {
    const probe = createLLMContextProbe();

    probe.context.token("Hi");
    probe.context.sentence("Hi.", 0);
    probe.context.complete("Hi.");

    expect(snapshotLLMContextProbe(probe)).toEqual({
      tokens: ["Hi"],
      sentences: [{ sentence: "Hi.", index: 0 }],
      completions: ["Hi."],
      fillerTexts: [],
      interruptions: 0,
      errors: [],
    });
  });

  it("passes when providers stay silent after abort", async () => {
    await assertNoSTTEventsAfterAbort(createSTTContextProbe(), () => {});
    await assertNoLLMEventsAfterAbort(createLLMContextProbe(), () => {});
    await assertNoTTSEventsAfterAbort(createTTSContextProbe(), () => {});
  });

  it("fails when a provider emits after abort", async () => {
    const probe = createSTTContextProbe();

    await expect(
      assertNoSTTEventsAfterAbort(probe, () => {
        probe.context.transcript("late", true);
      }),
    ).rejects.toThrow(ScenarioAssertionError);
  });

  it("records turn signals from STT providers and turn detectors", () => {
    const stt = createSTTContextProbe();
    stt.context.turn.eagerTurnEnd("hello");
    stt.context.turn.turnResumed();
    stt.context.turn.turnEnd("hello there");
    expect(stt.turnSignals).toEqual([
      { type: "eagerTurnEnd", transcript: "hello" },
      { type: "turnResumed" },
      { type: "turnEnd", transcript: "hello there" },
    ]);

    const detector = createTurnDetectorContextProbe({
      audioFormat: { encoding: "mulaw", sampleRate: 8000 },
    });
    expect(detector.context.audioFormat).toEqual({
      encoding: "mulaw",
      sampleRate: 8000,
      channels: 1,
    });
    detector.context.endOfTurnProbability(0.4);
    detector.context.turnAbandoned("noise");
    detector.context.turnEnd("done");
    expect(snapshotTurnDetectorContextProbe(detector)).toEqual({
      turnEnds: ["done"],
      abandonedTurns: ["noise"],
      turnSignals: [
        { type: "endOfTurnProbability", probability: 0.4 },
        { type: "turnAbandoned", reason: "noise" },
        { type: "turnEnd", transcript: "done" },
      ],
    });
  });

  it("records TTS word timings", () => {
    const probe = createTTSContextProbe();
    probe.context.wordTimings([{ word: "Hi", startMs: 0, endMs: 180 }]);
    expect(probe.wordTimings).toEqual([{ word: "Hi", startMs: 0, endMs: 180 }]);
  });

  it("fails when a turn detector emits signals after abort", async () => {
    const probe = createTurnDetectorContextProbe();
    await expect(
      assertNoTurnDetectorEventsAfterAbort(probe, () => {
        probe.context.endOfTurnProbability(0.9);
      }),
    ).rejects.toThrow(ScenarioAssertionError);
  });

  it("validates turn detector modes and optional hooks", () => {
    const valid = createFakeTurnDetector({ mode: "prediction" }).provider;
    expect(() => assertTurnDetectorProviderConformance(valid)).not.toThrow();

    const badMode = {
      ...valid,
      metadata: { ...valid.metadata, mode: "guess" },
    } as unknown as typeof valid;
    expect(() => assertTurnDetectorProviderConformance(badMode)).toThrow(ScenarioAssertionError);

    const badHook = { ...valid, onAudio: "not a function" } as unknown as typeof valid;
    expect(() => assertTurnDetectorProviderConformance(badHook)).toThrow(ScenarioAssertionError);
  });
});
