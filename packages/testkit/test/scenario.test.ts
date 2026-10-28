import { describe, expect, it } from "vitest";

import {
  assertEventInvariants,
  createScenario,
  runTrace,
  type RecordedEvent,
  type ScenarioTrace,
} from "../src";

function recorded(event: Record<string, unknown>): RecordedEvent {
  return {
    event: event as unknown as RecordedEvent["event"],
    receivedAt: Number(event.timestamp),
  };
}

describe("@talkio/testkit scenario", () => {
  it("runs a chained golden flow", async () => {
    const result = await createScenario()
      .start()
      .expectEvent("agent:started")
      .sttPartial("hello")
      .sttFinal("hello")
      .expectEvent("human-turn:started")
      .expectEvent("human-turn:transcript", { text: "hello", isFinal: false })
      .expectEvent("human-turn:transcript", { text: "hello", isFinal: true })
      .expectEvent("human-turn:ended", { transcript: "hello" })
      .expectEvent("ai-turn:started")
      .llmToken("Hi")
      .llmSentence("Hi there.", 0)
      .ttsChunk(7, 4)
      .llmComplete("Hi there.")
      .ttsComplete()
      .expectEvent("ai-turn:ended", { wasSpoken: true })
      .expectSnapshot((snapshot) => {
        expect(snapshot.messages).toEqual([
          { role: "user", content: "hello" },
          { role: "assistant", content: "Hi there." },
        ]);
      })
      .stop()
      .expectEvent("agent:stopped")
      .assertInvariants()
      .run();

    expect(result.events.byType("ai-turn:audio")).toHaveLength(1);
  });

  it("replays prediction-mode turn detection from a serializable trace", async () => {
    const trace: ScenarioTrace = [
      { type: "start" },
      { type: "expect.event", event: "agent:started" },
      { type: "vad.speechStart" },
      { type: "stt.final", text: "let me think" },
      { type: "vad.speechEnd", duration: 500 },
      { type: "turn.probability", probability: 0.1 },
      { type: "advance", ms: 1000 },
      { type: "expect.noEvent", event: "human-turn:ended" },
      { type: "turn.probability", probability: 0.9 },
      { type: "expect.event", event: "human-turn:ended", partial: { transcript: "let me think" } },
      { type: "expect.event", event: "ai-turn:started" },
      { type: "stop" },
      { type: "expect.event", event: "agent:stopped" },
      { type: "assert.invariants" },
    ];

    await runTrace(trace, {
      useVAD: true,
      useTurnDetector: true,
      turnDetectorMode: "prediction",
      turnTaking: { minEndOfTurnDelayMs: 400, maxEndOfTurnDelayMs: 2500 },
    });
  });

  it("runs a serializable trace", async () => {
    const trace: ScenarioTrace = [
      { type: "start" },
      { type: "expect.event", event: "agent:started" },
      { type: "stt.final", text: "hello" },
      { type: "expect.event", event: "human-turn:ended", partial: { transcript: "hello" } },
      { type: "expect.event", event: "ai-turn:started" },
      { type: "llm.sentence", text: "Hi.", index: 0 },
      { type: "tts.chunk", value: 1, size: 2 },
      { type: "llm.complete", text: "Hi." },
      { type: "tts.complete" },
      { type: "expect.event", event: "ai-turn:ended", partial: { wasSpoken: true } },
      { type: "stop" },
      { type: "expect.event", event: "agent:stopped" },
      { type: "assert.invariants" },
    ];

    const result = await runTrace(trace);

    expect(result.events.byType("human-turn:ended")[0]?.transcript).toBe("hello");
  });

  it("accepts agent-initiated turns but not AI turns that start while the user is mid-turn", () => {
    expect(() =>
      assertEventInvariants([
        recorded({ type: "agent:started", timestamp: 0 }),
        recorded({ type: "ai-turn:started", timestamp: 1 }),
        recorded({ type: "ai-turn:ended", text: "Hi!", metrics: {}, timestamp: 2 }),
      ]),
    ).not.toThrow();

    expect(() =>
      assertEventInvariants([
        recorded({ type: "agent:started", timestamp: 0 }),
        recorded({ type: "human-turn:started", timestamp: 1 }),
        recorded({ type: "ai-turn:started", timestamp: 2 }),
        recorded({ type: "agent:stopped", timestamp: 3 }),
      ]),
    ).toThrow("ai-turn:started emitted while a human turn was open");
  });

  it("runs a greeting through agent.say", async () => {
    const result = await createScenario()
      .start()
      .expectEvent("agent:started")
      .step("say", ({ agent }) => agent.say("Welcome back."))
      .expectEvent("ai-turn:started")
      .ttsChunk(1, 2)
      .ttsComplete()
      .expectEvent("ai-turn:ended", { text: "Welcome back." })
      .stop()
      .expectEvent("agent:stopped")
      .assertInvariants()
      .assertTraceInvariants()
      .run();
    expect(result.llm.generations).toBe(0);
  });

  it("rejects stale audio of an interrupted turn but lets a backchannel play", () => {
    const interrupted = [
      recorded({ type: "agent:started", timestamp: 0 }),
      recorded({ type: "human-turn:started", timestamp: 1 }),
      recorded({ type: "human-turn:ended", transcript: "hello", metrics: {}, timestamp: 2 }),
      recorded({ type: "ai-turn:started", turnId: "reply", timestamp: 3 }),
      recorded({
        type: "ai-turn:interrupted",
        turnId: "reply",
        partialText: "",
        metrics: {},
        timestamp: 4,
      }),
      recorded({ type: "human-turn:started", timestamp: 5 }),
    ];
    const audio = (turnId: string) =>
      recorded({ type: "ai-turn:audio", turnId, audio: new ArrayBuffer(1), timestamp: 6 });

    expect(() => assertEventInvariants([...interrupted, audio("reply")])).toThrow(
      "Stale ai-turn:audio emitted after interruption",
    );
    expect(() =>
      assertEventInvariants([
        ...interrupted,
        recorded({ type: "agent:backchannel", turnId: "ack", text: "Mm-hmm.", timestamp: 6 }),
        audio("ack"),
      ]),
    ).not.toThrow();
  });
});
