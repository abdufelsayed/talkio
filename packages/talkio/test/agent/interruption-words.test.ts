import { describe, expect, it, vi } from "vitest";

import { classifyInterruption, isEcho, startsWithInterruptionCue } from "../../src/agent/overlap";
import type { InterruptionClassifier } from "../../src/types/config";
import { createTestAgent, startSpeaking } from "../helpers/agent-harness";

function speaking(options: Parameters<typeof createTestAgent>[0] = {}, sentence?: string) {
  const harness = createTestAgent({ vad: true, ...options });
  startSpeaking(harness, sentence);
  return harness;
}

describe("words-based interruptions", () => {
  it("resumes after a backchannel longer than the false-start threshold", () => {
    const harness = speaking();
    harness.vad?.emitSpeechStart();
    harness.clock.increment(350);
    harness.stt.emitTranscript("mm-hmm", false);
    harness.vad?.emitSpeechEnd(350);

    expect(harness.ofType("ai-turn:interruption-cancelled")).toMatchObject([
      { reason: "backchannel" },
    ]);
    expect(harness.ofType("ai-turn:interrupted")).toHaveLength(0);
    expect(harness.ofType("human-turn:started")).toHaveLength(1);
    harness.agent.stop();
  });

  it("resumes when an acknowledgement is transcribed after the user stopped", () => {
    const harness = speaking();
    harness.vad?.emitSpeechStart();
    harness.clock.increment(400);
    harness.vad?.emitSpeechEnd(400);
    harness.clock.increment(150);
    harness.stt.emitTranscript("Yeah.", true);

    expect(harness.ofType("ai-turn:interruption-cancelled")).toMatchObject([
      { reason: "backchannel" },
    ]);
    expect(harness.ofType("ai-turn:interrupted")).toHaveLength(0);
    harness.agent.stop();
  });

  it("resumes after speech that never produces words", () => {
    const harness = speaking();
    harness.vad?.emitSpeechStart();
    harness.clock.increment(500);
    harness.vad?.emitSpeechEnd(500);
    harness.clock.increment(599);
    expect(harness.ofType("ai-turn:interruption-cancelled")).toHaveLength(0);
    harness.clock.increment(1);

    expect(harness.ofType("ai-turn:interruption-cancelled")).toMatchObject([
      { reason: "no-transcript" },
    ]);
    expect(harness.ofType("ai-turn:interrupted")).toHaveLength(0);
    harness.agent.stop();
  });

  it("stops waiting for words after maxPendingMs of continuous sound", () => {
    const harness = speaking({ interruption: { maxPendingMs: 2000 } });
    harness.vad?.emitSpeechStart();
    harness.clock.increment(2000);

    expect(harness.ofType("ai-turn:interruption-cancelled")).toMatchObject([
      { reason: "no-transcript" },
    ]);
    harness.agent.stop();
  });

  it("interrupts on an interruption cue before a second word arrives", () => {
    const harness = speaking();
    harness.vad?.emitSpeechStart();
    harness.clock.increment(250);
    harness.stt.emitTranscript("Stop", false);

    expect(harness.ofType("ai-turn:interrupted")).toHaveLength(1);
    harness.agent.stop();
  });

  it("ignores its own echo and stops pausing for voice alone afterwards", () => {
    const harness = speaking({}, "The weather today is sunny and warm.");
    harness.vad?.emitSpeechStart();
    harness.clock.increment(300);
    harness.stt.emitTranscript("the weather today is sunny", false);
    harness.vad?.emitSpeechEnd(300);
    expect(harness.ofType("ai-turn:interruption-cancelled")).toMatchObject([{ reason: "echo" }]);

    harness.vad?.emitSpeechStart();
    expect(harness.ofType("ai-turn:interruption-pending")).toHaveLength(1);
    harness.stt.emitTranscript("wait what about tomorrow", false);
    expect(harness.ofType("ai-turn:interrupted")).toHaveLength(1);
    harness.agent.stop();
  });

  it("uses a custom classifier and keeps the agent paused while it decides", async () => {
    let decide: ((verdict: "interrupt" | "backchannel") => void) | undefined;
    const classifier: InterruptionClassifier = () =>
      new Promise((resolve) => {
        decide = resolve;
      });
    const harness = speaking({ interruption: { classifier } });
    harness.vad?.emitSpeechStart();
    harness.stt.emitTranscript("could you repeat that", false);
    expect(harness.ofType("ai-turn:interrupted")).toHaveLength(0);
    expect(harness.ofType("audio:resume")).toHaveLength(0);

    decide?.("interrupt");
    await vi.waitFor(() => expect(harness.ofType("ai-turn:interrupted")).toHaveLength(1));
    harness.agent.stop();
  });

  it("interrupts on any speech when minDurationMs is 0", () => {
    const harness = speaking({ interruption: { minDurationMs: 0 } });
    harness.vad?.emitSpeechStart();
    expect(harness.ofType("ai-turn:interrupted")).toHaveLength(1);
    harness.agent.stop();
  });
});

const classifierConfig = { interimMinWords: 2, interimMinChars: 3 };

function input(transcript: string, isFinal = false, agentText = "") {
  return { transcript, isFinal, agentText, speechMs: 400, messages: [] };
}

describe("interruption classifier", () => {
  const config = classifierConfig;

  it("classifies acknowledgements, cues, and content", () => {
    expect(classifyInterruption(input("uh-huh yeah"), config)).toBe("backchannel");
    expect(classifyInterruption(input("Okay.", true), config)).toBe("backchannel");
    expect(classifyInterruption(input("wait"), config)).toBe("interrupt");
    expect(classifyInterruption(input("hold on"), config)).toBe("interrupt");
    expect(classifyInterruption(input("Paris"), config)).toBe("undecided");
    expect(classifyInterruption(input("Paris", true), config)).toBe("interrupt");
    expect(classifyInterruption(input("what about Paris"), config)).toBe("interrupt");
    expect(classifyInterruption(input("yeah but what about"), config)).toBe("interrupt");
  });

  it("recognizes the agent's own words in order as echo", () => {
    const agentText = "Your table for two is booked at eight tonight.";
    expect(isEcho("table for two is booked", agentText)).toBe(true);
    expect(isEcho("booked two table for", agentText)).toBe(false);
    expect(isEcho("is it booked for tomorrow instead", agentText)).toBe(false);
    expect(classifyInterruption(input("is booked at eight", false, agentText), config)).toBe(
      "echo",
    );
  });

  it("detects interruption cues only at the start", () => {
    expect(startsWithInterruptionCue("Sorry, one question")).toBe(true);
    expect(startsWithInterruptionCue("I am not sorry")).toBe(false);
  });
});
