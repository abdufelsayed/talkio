import { describe, expect, it } from "vitest";

import {
  assertNoLLMEventsAfterAbort,
  assertNoSTTEventsAfterAbort,
  assertNoTTSEventsAfterAbort,
  createLLMContextProbe,
  createSTTContextProbe,
  createTTSContextProbe,
  ScenarioAssertionError,
  snapshotLLMContextProbe,
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
});
