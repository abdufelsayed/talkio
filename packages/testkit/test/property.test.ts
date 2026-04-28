import { fc, test } from "@fast-check/vitest";
import { describe } from "vitest";

import { runTrace, scenarioTraceArbitrary } from "../src";

describe("@talkio/testkit properties", () => {
  test.prop([scenarioTraceArbitrary({ minTurns: 1, maxTurns: 3 })], {
    numRuns: 20,
  })("generated traces satisfy public event invariants", async (trace) => {
    const result = await runTrace(trace);
    result.events.assertInvariants();
  });

  test("generated trace arbitrary can be sampled with fast-check", () => {
    const samples = fc.sample(scenarioTraceArbitrary({ turns: 1 }), { numRuns: 2, seed: 42 });
    fc.assert(
      fc.property(fc.constantFrom(...samples), (trace) => {
        return trace[0]?.type === "start" && trace.at(-1)?.type === "assert.invariants";
      }),
    );
  });
});
