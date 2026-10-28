import { fc, test } from "@fast-check/vitest";
import { describe } from "vitest";

import {
  aiTurnLifecycleTraceArbitrary,
  assertTraceInvariants,
  runTrace,
  scenarioTraceArbitrary,
} from "../src";

// Generated traces drive a simulated clock, so expected events either exist already or never
// arrive. A short wait makes a failing trace report its assertion instead of timing out.
const PROPERTY_TRACE_OPTIONS = { eventTimeoutMs: 50 };

describe("@talkio/testkit properties", () => {
  test.prop([scenarioTraceArbitrary({ minTurns: 1, maxTurns: 3 })], {
    numRuns: 20,
  })("generated traces satisfy public event invariants", async (trace) => {
    const result = await runTrace(trace, PROPERTY_TRACE_OPTIONS);
    result.events.assertInvariants();
    assertTraceInvariants(result.traces);
  });

  test.prop([aiTurnLifecycleTraceArbitrary({ minTurns: 1, maxTurns: 3 })], {
    numRuns: 30,
  })("generated AI turn lifecycle traces satisfy trace invariants", async (trace) => {
    const result = await runTrace(trace, PROPERTY_TRACE_OPTIONS);
    result.events.assertInvariants();
    assertTraceInvariants(result.traces);
  });

  test("generated trace arbitrary can be sampled with fast-check", () => {
    const samples = fc.sample(scenarioTraceArbitrary({ turns: 1 }), { numRuns: 2, seed: 42 });
    fc.assert(
      fc.property(fc.constantFrom(...samples), (trace) => {
        return (
          trace[0]?.type === "start" &&
          trace.some((step) => step.type === "assert.invariants") &&
          trace.at(-1)?.type === "assert.traceInvariants"
        );
      }),
    );
  });
});
