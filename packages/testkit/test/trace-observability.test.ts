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

function trace(event: { type: string; turnId?: string; requestId?: string }) {
  return { ...event, sessionId: "session", timestamp: 0 };
}

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
      .expectEvent("agent-turn:started")
      .advance(40)
      .llmToken("Hi")
      .advance(20)
      .llmSentence("Hi.", 0)
      .advance(70)
      .ttsChunk(1, 4)
      .advance(10)
      .llmComplete("Hi.")
      .ttsComplete()
      .expectEvent("agent-turn:ended")
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

  it("checks backchannel traces and keeps backchannels out of turn latencies", async () => {
    const result = await createScenario({
      useVAD: true,
      useTurnDetector: true,
      turnTaking: { minDelayMs: 400, maxDelayMs: 2500 },
      backchannels: true,
    })
      .start()
      .expectEvent("agent:started")
      .vadSpeechStart()
      .sttFinal("so first I went to the station and then")
      .advance(4500)
      .vadSpeechEnd(4500)
      .turnProbability(0.1)
      .advance(400)
      .expectEvent("agent:backchannel", { text: "Mm-hmm." })
      .ttsChunk(1, 2)
      .ttsComplete()
      .turnProbability(0.95)
      .expectEvent("agent-turn:started")
      .llmSentence("The station was closed.", 0)
      .ttsChunk(3, 2)
      .llmComplete("The station was closed.")
      .ttsComplete()
      .expectEvent("agent-turn:ended", { text: "The station was closed." })
      .stop()
      .expectEvent("agent:stopped")
      .assertInvariants()
      .assertTraceInvariants()
      .run();

    expect(result.tts.requestedTexts).toEqual(["Mm-hmm.", "The station was closed."]);
    const [reply] = result.events.byType("agent-turn:started");
    const [backchannel] = result.events.byType("agent:backchannel");
    expect(collectTraceLatencies(result.traces).map((turn) => turn.turnId)).toEqual([
      reply?.turnId,
    ]);
    expect(
      result.traces
        .filter((event) => event.type === "agent-turn:audio")
        .map((event) => event.turnId),
    ).toEqual([backchannel?.turnId, reply?.turnId]);
  });

  it("requires think and backchannel traces to name a known turn", () => {
    expect(() => assertTraceInvariants([trace({ type: "agent-turn:think" })])).toThrow(
      "missing turnId",
    );
    expect(() =>
      assertTraceInvariants([trace({ type: "tts:start", turnId: "ack", requestId: "r1" })]),
    ).toThrow("unknown turnId");
    expect(() =>
      assertTraceInvariants([
        trace({ type: "backchannel:started", turnId: "ack" }),
        trace({ type: "tts:start", turnId: "ack", requestId: "r1" }),
        trace({ type: "tts:complete", turnId: "ack", requestId: "r1" }),
      ]),
    ).not.toThrow();
  });

  it("fails when latency budgets are exceeded", async () => {
    const result = await createScenario()
      .start()
      .expectEvent("agent:started")
      .sttFinal("slow")
      .expectEvent("agent-turn:started")
      .advance(200)
      .llmToken("Slow")
      .llmSentence("Slow.", 0)
      .ttsChunk(1, 2)
      .llmComplete("Slow.")
      .ttsComplete()
      .expectEvent("agent-turn:ended")
      .run();

    expect(() => assertTraceLatencyBudgets(result.traces, { maxTimeToFirstTokenMs: 100 })).toThrow(
      ScenarioAssertionError,
    );
  });
});
