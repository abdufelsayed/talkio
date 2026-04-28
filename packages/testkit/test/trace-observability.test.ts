import { describe, expect, it } from "vitest";

import {
  assertTraceInvariants,
  assertTraceLatencyBudgets,
  collectTraceLatencies,
  createScenario,
  REGRESSION_TRACE_FIXTURES,
  runTrace,
  ScenarioAssertionError,
} from "../src";

describe("@talkio/testkit trace observability", () => {
  it.each(REGRESSION_TRACE_FIXTURES)("replays $name", async (fixture) => {
    const result = await runTrace(fixture.trace, fixture.options);

    assertTraceInvariants(result.traces);
    assertTraceLatencyBudgets(result.traces, fixture.latencyBudgets);
    result.events.assertInvariants();
  });

  it("extracts latency samples from trace events", async () => {
    const result = await createScenario()
      .start()
      .expectEvent("agent:started")
      .sttFinal("hello")
      .expectEvent("ai-turn:started")
      .advance(40)
      .llmToken("Hi")
      .advance(20)
      .llmSentence("Hi.", 0)
      .advance(70)
      .ttsChunk(1, 4)
      .advance(10)
      .llmComplete("Hi.")
      .ttsComplete()
      .expectEvent("ai-turn:ended")
      .assertTraceInvariants()
      .assertLatencyBudgets({
        maxTimeToFirstTokenMs: 40,
        maxTimeToFirstSentenceMs: 20,
        maxTimeToFirstAudioMs: 70,
        maxTimeToFirstAudioFromTurnStartMs: 130,
        maxAudioSendLagMs: 0,
        maxAudioDrops: 0,
      })
      .run();

    const [latency] = collectTraceLatencies(result.traces);
    expect(latency?.timeToFirstTokenMs).toBe(40);
    expect(latency?.timeToFirstSentenceMs).toBe(20);
    expect(latency?.timeToFirstAudioMs).toBe(70);
    expect(latency?.timeToFirstAudioFromTurnStartMs).toBe(130);
  });

  it("fails when latency budgets are exceeded", async () => {
    const result = await createScenario()
      .start()
      .expectEvent("agent:started")
      .sttFinal("slow")
      .expectEvent("ai-turn:started")
      .advance(200)
      .llmToken("Slow")
      .llmSentence("Slow.", 0)
      .ttsChunk(1, 2)
      .llmComplete("Slow.")
      .ttsComplete()
      .expectEvent("ai-turn:ended")
      .run();

    expect(() => assertTraceLatencyBudgets(result.traces, { maxTimeToFirstTokenMs: 100 })).toThrow(
      ScenarioAssertionError,
    );
  });
});
