import { describe, expect, it } from "vitest";

import { createTestAgent } from "../helpers/agent-harness";

describe("agent state", () => {
  it("reports idle, running, and stopped", () => {
    const { agent } = createTestAgent();
    expect(agent.getSnapshot().status).toBe("idle");
    agent.start();
    expect(agent.getSnapshot().status).toBe("running");
    agent.stop();
    expect(agent.getSnapshot().status).toBe("stopped");
  });

  it("holds what the user has said in the current turn, final and interim", () => {
    const { agent, vad, stt, turnDetector } = createTestAgent({
      vad: true,
      turnDetector: "decision",
    });
    agent.start();
    vad?.emitSpeechStart();
    stt.emitTranscript("I want to", true);
    stt.emitTranscript("fly to", false);
    expect(agent.getSnapshot().transcript).toBe("I want to fly to");

    turnDetector?.emitEnd();
    expect(agent.getSnapshot().transcript).toBe("");
    agent.stop();
  });
});
