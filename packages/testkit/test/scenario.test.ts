import { describe, expect, it } from "vitest";

import { createScenario, runTrace, type ScenarioTrace } from "../src";

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
});
