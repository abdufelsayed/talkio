import { describe, expect, it } from "vitest";

import { audioChunk, bytesOf, createTestAgent, startSpeaking } from "../helpers/agent-harness";

describe("pending interruptions", () => {
  it("pauses audio instead of discarding it, then resumes after a false start", () => {
    const harness = createTestAgent({ vad: true });
    const { vad, tts, clock, ofType } = harness;
    startSpeaking(harness);
    const activeRequest = tts.getCurrentRequest();

    vad?.emitSpeechStart();
    expect(ofType("ai-turn:interruption-pending")).toHaveLength(1);
    expect(ofType("audio:pause")).toHaveLength(1);
    expect(ofType("audio:clear")).toHaveLength(0);
    expect(tts.abortedIds).not.toContain(activeRequest?.id);

    tts.emitAudio(audioChunk(3, 4));
    expect(ofType("ai-turn:audio")).toHaveLength(1);

    clock.increment(80);
    vad?.emitSpeechEnd(80);

    expect(ofType("ai-turn:interruption-cancelled")).toMatchObject([{ reason: "false-start" }]);
    expect(ofType("audio:resume")).toHaveLength(1);
    expect(ofType("ai-turn:audio").map((event) => bytesOf(event.audio))).toEqual([
      [1, 2],
      [3, 4],
    ]);
    harness.agent.stop();
  });

  it("speaks sentences generated while an interruption was pending once it is cancelled", () => {
    const harness = createTestAgent({ vad: true });
    const { vad, llm, tts, clock, ofType, agent } = harness;
    startSpeaking(harness, "First.");

    vad?.emitSpeechStart();
    llm.emitSentence("Second.", 1);
    llm.complete("First. Second.");
    clock.increment(50);
    vad?.emitSpeechEnd(50);

    tts.complete();
    expect(tts.getCurrentRequest()?.text).toBe("Second.");
    tts.emitAudio(audioChunk(5));
    tts.complete();

    expect(ofType("ai-turn:ended")).toMatchObject([{ text: "First. Second.", wasSpoken: true }]);
    expect(agent.getSnapshot().messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "First. Second." },
    ]);
    agent.stop();
  });

  it("clears audio in clear mode but still continues the turn after a false start", () => {
    const harness = createTestAgent({ vad: true, interruption: { pendingAudio: "clear" } });
    const { vad, tts, llm, clock, ofType, agent } = harness;
    startSpeaking(harness);

    vad?.emitSpeechStart();
    expect(ofType("audio:clear")).toHaveLength(1);
    expect(ofType("audio:pause")).toHaveLength(0);

    clock.increment(60);
    vad?.emitSpeechEnd(60);
    expect(ofType("audio:resume")).toHaveLength(1);

    llm.complete("Hello there.");
    tts.complete();
    expect(ofType("ai-turn:ended")).toHaveLength(1);
    agent.stop();
  });

  it("does not start talking over a user who began speaking before the first audio", () => {
    const harness = createTestAgent({ vad: true });
    const { agent, stt, llm, tts, vad, clock, ofType } = harness;
    agent.start();
    stt.emitTranscript("hello", true);

    vad?.emitSpeechStart();
    llm.emitSentence("Answer.", 0);
    tts.emitAudio(audioChunk(9));
    expect(ofType("ai-turn:audio")).toHaveLength(0);
    expect(ofType("audio:pause")).toHaveLength(0);

    clock.increment(200);
    stt.emitTranscript("can you also check", false);
    expect(ofType("ai-turn:interrupted")).toMatchObject([{ audioStartedText: "" }]);
    expect(ofType("audio:clear")).toHaveLength(0);
    agent.stop();
  });

  it("requires STT speech to last the minimum duration before interrupting", () => {
    const harness = createTestAgent({ interruption: { minDurationMs: 200 } });
    const { stt, clock, ofType, agent } = harness;
    startSpeaking(harness);

    stt.emitSpeechStart();
    clock.increment(100);
    stt.emitTranscript("uh", false);
    expect(ofType("ai-turn:interrupted")).toHaveLength(0);

    stt.emitSpeechEnd();
    expect(ofType("ai-turn:interruption-cancelled")).toMatchObject([{ reason: "false-start" }]);
    clock.increment(500);
    expect(ofType("ai-turn:interrupted")).toHaveLength(0);
    agent.stop();
  });

  it("confirms an interruption once the user's words arrive", () => {
    const harness = createTestAgent({ interruption: { minDurationMs: 200 } });
    const { stt, clock, ofType, agent } = harness;
    startSpeaking(harness);

    stt.emitSpeechStart();
    clock.increment(250);
    expect(ofType("ai-turn:interrupted")).toHaveLength(0);

    stt.emitTranscript("hold on a second", false);
    expect(ofType("ai-turn:interrupted")).toHaveLength(1);
    expect(ofType("audio:clear")).toHaveLength(1);
    expect(ofType("human-turn:started")).toHaveLength(2);
    agent.stop();
  });

  it("interrupts on an explicit turn end from a turn detector", () => {
    const harness = createTestAgent({
      turnDetector: "decision",
      interruption: { minDurationMs: 0 },
    });
    const { agent, llm, turnDetector, ofType } = harness;
    agent.start();
    turnDetector?.emitEnd("hello");
    llm.emitSentence("Hello.", 0);

    turnDetector?.emitEnd("actually wait");
    expect(ofType("ai-turn:interrupted")).toHaveLength(1);
    expect(ofType("human-turn:ended").map((event) => event.transcript)).toEqual([
      "hello",
      "actually wait",
    ]);
    agent.stop();
  });
});

describe("user turns while the agent cannot be interrupted", () => {
  it("answers a user turn after the current response instead of dropping it", () => {
    const harness = createTestAgent({ interruption: false });
    const { stt, llm, tts, ofType, agent } = harness;
    startSpeaking(harness);

    stt.emitTranscript("and one more thing", true);
    expect(ofType("ai-turn:interrupted")).toHaveLength(0);
    expect(ofType("ai-turn:started")).toHaveLength(1);

    llm.complete("Hello there.");
    tts.complete();

    expect(ofType("ai-turn:started")).toHaveLength(2);
    expect(agent.getSnapshot().messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello there." },
      { role: "user", content: "and one more thing" },
    ]);
    agent.stop();
  });

  it("does not take its own voice for a user turn", () => {
    const harness = createTestAgent({ interruption: false });
    startSpeaking(harness, "Your order ships on Monday.");
    harness.stt.emitTranscript("your order ships on Monday", true);
    expect(harness.ofType("human-turn:abandoned")).toMatchObject([{ reason: "echo" }]);

    harness.llm.complete("Your order ships on Monday.");
    harness.tts.complete();
    expect(harness.llm.generations).toBe(1);
    expect(harness.agent.getSnapshot().messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Your order ships on Monday." },
    ]);
    harness.agent.stop();
  });
});

describe("conversation history", () => {
  it("merges user turns when the agent said nothing audible in between", () => {
    const harness = createTestAgent();
    const { agent, stt, llm, ofType } = harness;
    agent.start();
    stt.emitTranscript("I want to book a flight", true);
    llm.emitToken("Sure");
    stt.emitTranscript("to Paris", true);

    expect(ofType("ai-turn:interrupted")).toHaveLength(1);
    expect(agent.getSnapshot().messages).toEqual([
      { role: "user", content: "I want to book a flight to Paris" },
    ]);
    agent.stop();
  });

  it("keeps user turns separate when the agent was audibly cut off", () => {
    const harness = createTestAgent();
    const { agent, stt } = harness;
    startSpeaking(harness);
    stt.emitTranscript("stop there", true);

    expect(agent.getSnapshot().messages).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "stop there" },
    ]);
    agent.stop();
  });

  it("ignores empty final transcripts", () => {
    const harness = createTestAgent();
    const { agent, stt, ofType } = harness;
    agent.start();
    stt.emitTranscript("   ", true);

    expect(ofType("human-turn:started")).toHaveLength(0);
    expect(ofType("ai-turn:started")).toHaveLength(0);
    agent.stop();
  });
});

describe("audio stream", () => {
  it("discards unread audio of an interrupted turn", async () => {
    const harness = createTestAgent({ vad: true });
    const { agent, vad, stt, llm, tts, clock } = harness;
    startSpeaking(harness);
    tts.emitAudio(audioChunk(7));

    vad?.emitSpeechStart();
    clock.increment(200);
    vad?.emitSpeechEnd(200);
    stt.emitTranscript("next question", true);
    llm.emitSentence("Next answer.", 0);
    tts.emitAudio(audioChunk(9));

    const reader = agent.audioStream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(bytesOf(first.value)).toEqual([9]);
    agent.stop();
  });

  it("delivers audio to a reader that is waiting for it", async () => {
    const harness = createTestAgent();
    const reader = harness.agent.audioStream.getReader();
    const read = reader.read();
    startSpeaking(harness);

    const result = await read;
    expect(result.done).toBe(false);
    expect(bytesOf(result.value)).toEqual([1, 2]);
    harness.agent.stop();
  });
});
