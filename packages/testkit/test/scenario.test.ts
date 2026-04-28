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

  it("rejects stale public audio after interruption", () => {
    expect(() =>
      assertEventInvariants([
        recorded({ type: "agent:started", timestamp: 0 }),
        recorded({ type: "human-turn:started", timestamp: 1 }),
        recorded({ type: "human-turn:ended", transcript: "hello", metrics: {}, timestamp: 2 }),
        recorded({ type: "ai-turn:started", timestamp: 3 }),
        recorded({ type: "ai-turn:interrupted", partialText: "", metrics: {}, timestamp: 4 }),
        recorded({ type: "ai-turn:audio", audio: new ArrayBuffer(1), timestamp: 5 }),
      ]),
    ).toThrow("Stale ai-turn:audio emitted after interruption");
  });
});
