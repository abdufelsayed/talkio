import { describe, expect, it } from "vitest";

import {
  assertNoLLMEventsAfterAbort,
  assertNoSTTEventsAfterAbort,
  assertNoTTSEventsAfterAbort,
  assertNoTurnDetectorEventsAfterAbort,
  assertTurnDetectorConformance,
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
    stt.context.turn.eagerEnd("hello");
    stt.context.turn.resumed();
    stt.context.turn.end("hello there");
    expect(stt.turnSignals).toEqual([
      { type: "eagerEnd", transcript: "hello" },
      { type: "resumed" },
      { type: "end", transcript: "hello there" },
    ]);

    const detector = createTurnDetectorContextProbe({
      audioFormat: { encoding: "mulaw", sampleRate: 8000 },
    });
    expect(detector.context.audioFormat).toEqual({
      encoding: "mulaw",
      sampleRate: 8000,
      channels: 1,
    });
    detector.context.turn.probability(0.4);
    detector.context.turn.abandoned("noise");
    detector.context.turn.end();
    detector.context.error(new Error("model crashed"));
    expect(detector.probabilities).toEqual([0.4]);
    expect(snapshotTurnDetectorContextProbe(detector)).toEqual({
      turnEnds: [undefined],
      abandonedTurns: ["noise"],
      turnSignals: [
        { type: "probability", probability: 0.4 },
        { type: "abandoned", reason: "noise" },
        { type: "end", transcript: undefined },
      ],
      errors: ["model crashed"],
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
        probe.context.turn.probability(0.9);
      }),
    ).rejects.toThrow(ScenarioAssertionError);
  });

  it("validates turn detector outputs and optional hooks", () => {
    const valid = createFakeTurnDetector({ output: "decision" }).provider;
    expect(() => assertTurnDetectorConformance(valid)).not.toThrow();
    expect(() => assertTurnDetectorConformance(() => 0.5)).not.toThrow();
    expect(() => assertTurnDetectorConformance({})).not.toThrow();
    expect(() =>
      assertTurnDetectorConformance(valid, { expectedName: "FakeTurnDetector" }),
    ).not.toThrow();
    expect(() => assertTurnDetectorConformance(valid, { expectedName: "Other" })).toThrow(
      "turnDetector.name expected Other",
    );

    const badOutput = { ...valid, output: "guess" } as unknown as typeof valid;
    expect(() => assertTurnDetectorConformance(badOutput)).toThrow(
      'turnDetector.output must be "probability" or "decision"',
    );

    const badHook = { ...valid, sendAudio: "not a function" } as unknown as typeof valid;
    expect(() => assertTurnDetectorConformance([() => 0.5, badHook])).toThrow(
      "turnDetector[1].sendAudio",
    );
  });

  it("gives a turn detector pauses that abort with the probe", () => {
    const probe = createTurnDetectorContextProbe();
    const pause = probe.pause("hello", [{ role: "assistant", content: "Hi!" }]);
    expect(pause).toMatchObject({
      transcript: "hello",
      messages: [{ role: "assistant", content: "Hi!" }],
    });
    expect(pause.signal.aborted).toBe(false);
    probe.abort();
    expect(pause.signal.aborted).toBe(true);
    expect(probe.pause("late").signal.aborted).toBe(true);
  });
});
