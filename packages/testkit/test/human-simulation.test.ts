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
    expect(sample?.backchannel.speechMs).toBeGreaterThan(200);
  });

  it("keeps human-likeness metrics within default thresholds", async () => {
    const score = await runHumanSimulation({ runs: 20, seed: 20260428 });

    assertHumanSimulationPass(score);
    expect(score.falseInterruptions).toBe(0);
    expect(score.missedInterruptions).toBe(0);
    expect(score.staleAudioAfterInterruption).toBe(0);
    expect(score.unexpectedAIStarts).toBe(0);
    expect(score.misclassifiedOverlaps).toBe(0);
    expect(score.interruptedTurns).toBe(20);
    expect(score.backchannelTurns).toBe(20);
    expect(score.noiseTurns).toBe(20);
    expect(score.echoTurns).toBe(20);
    expect(score.speculativeCutoffs).toBe(100);
    expect(score.cancelledSpeculativeCutoffs).toBe(80);
    expect(score.maxSpeculativeCutoffLatencyMs).toBe(0);
    expect(score.maxBargeInLatencyMs).toBeLessThanOrEqual(400);
  });

  it("fails when backchannels interrupt the agent", async () => {
    const score = await runHumanSimulation({ runs: 2, seed: 7 });
    expect(() => assertHumanSimulationPass({ ...score, falseInterruptions: 1 })).toThrow(
      "false interruptions: 1",
    );
    expect(() => assertHumanSimulationPass({ ...score, misclassifiedOverlaps: 1 })).toThrow(
      "misclassified overlaps: 1",
    );
  });
});
