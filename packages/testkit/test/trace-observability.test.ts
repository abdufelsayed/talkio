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

  it("checks backchannel and filler traces and keeps backchannels out of turn latencies", async () => {
    const result = await createScenario({
      useVAD: true,
      useTurnDetector: true,
      turnDetectorMode: "prediction",
      turnTaking: { minEndOfTurnDelayMs: 400, maxEndOfTurnDelayMs: 2500 },
      backchannels: { enabled: true },
      fillers: { enabled: true },
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
      .expectEvent("ai-turn:started")
      .advance(1200)
      .expectTrace("ai-turn:filler")
      .ttsChunk(2, 2)
      .ttsComplete()
      .llmSentence("The station was closed.", 0)
      .ttsChunk(3, 2)
      .llmComplete("The station was closed.")
      .ttsComplete()
      .expectEvent("ai-turn:ended", { text: "The station was closed." })
      .stop()
      .expectEvent("agent:stopped")
      .assertInvariants()
      .assertTraceInvariants()
      .run();

    expect(result.tts.requestedTexts).toEqual([
      "Mm-hmm.",
      "One moment.",
      "The station was closed.",
    ]);
    const [reply] = result.events.byType("ai-turn:started");
    const [backchannel] = result.events.byType("agent:backchannel");
    expect(collectTraceLatencies(result.traces).map((turn) => turn.turnId)).toEqual([
      reply?.turnId,
    ]);
    expect(
      result.traces.filter((event) => event.type === "ai-turn:audio").map((event) => event.turnId),
    ).toEqual([backchannel?.turnId, reply?.turnId, reply?.turnId]);
  });

  it("keeps trace invariants when a recorded filler is replayed", async () => {
    const result = await createScenario({ fillers: { enabled: true, phrases: ["One moment."] } })
      .start()
      .expectEvent("agent:started")
      .sttFinal("first question")
      .expectEvent("ai-turn:started")
      .advance(1200)
      .ttsChunk(1, 2)
      .ttsComplete()
      .llmSentence("Here you go.", 0)
      .ttsChunk(2, 2)
      .llmComplete("Here you go.")
      .ttsComplete()
      .expectEvent("ai-turn:ended")
      .sttFinal("second question")
      .expectEvent("ai-turn:started")
      .advance(1200)
      .expectTrace("phrase:replayed", { data: { text: "One moment." } })
      .llmSentence("Here you go.", 0)
      .ttsChunk(3, 2)
      .llmComplete("Here you go.")
      .ttsComplete()
      .expectEvent("ai-turn:ended", { text: "Here you go." })
      .stop()
      .expectEvent("agent:stopped")
      .assertInvariants()
      .assertTraceInvariants()
      .run();

    expect(result.tts.requestedTexts).toEqual(["One moment.", "Here you go.", "Here you go."]);
  });

  it("requires filler and backchannel traces to name a known turn", () => {
    expect(() => assertTraceInvariants([trace({ type: "ai-turn:filler" })])).toThrow(
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
