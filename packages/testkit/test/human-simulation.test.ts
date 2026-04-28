import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertHumanSimulationPass,
  humanSimulationPlanArbitrary,
  runHumanSimulation,
} from "../src";

describe("@talkio/testkit human simulation", () => {
  it("samples generated human timing profiles", () => {
    const [sample] = fc.sample(humanSimulationPlanArbitrary(), { numRuns: 1, seed: 42 });
    expect(sample?.completion.speechMs).toBeGreaterThan(0);
  });

  it("keeps human-likeness metrics within default thresholds", async () => {
    const score = await runHumanSimulation({ runs: 20, seed: 20260428 });

    assertHumanSimulationPass(score);
    expect(score.falseInterruptions).toBe(0);
    expect(score.missedInterruptions).toBe(0);
    expect(score.staleAudioAfterInterruption).toBe(0);
    expect(score.unexpectedAIStarts).toBe(0);
    expect(score.backchannelTurns).toBe(20);
    expect(score.speculativeCutoffs).toBe(60);
    expect(score.cancelledSpeculativeCutoffs).toBe(40);
    expect(score.maxSpeculativeCutoffLatencyMs).toBe(0);
    expect(score.maxBargeInLatencyMs).toBeLessThanOrEqual(200);
  });
});
