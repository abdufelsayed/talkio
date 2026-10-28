import { describe, expect, it } from "vitest";
import { SimulatedClock, createActor } from "xstate";

import { createAudioOutputBuffer } from "../../src/agent/audio-output";
import { normalizeAgentConfig } from "../../src/agent/config";
import { agentMachine } from "../../src/agent/machine";
import { createFakeLLM, createFakeSTT, createFakeTTS } from "../helpers/fake-providers";

function createMachineActor() {
  const config = normalizeAgentConfig(
    {
      stt: createFakeSTT().provider,
      llm: createFakeLLM().provider,
      tts: createFakeTTS().provider,
    },
    "test-session",
  );
  return createActor(agentMachine, {
    input: { config, audioOutput: createAudioOutputBuffer() },
    clock: new SimulatedClock(),
  });
}

describe("agent machine transitions", () => {
  it("starts idle and runs the input, human, and ai regions in parallel", () => {
    const actor = createMachineActor();
    expect(actor.getSnapshot().value).toBe("idle");

    actor.start();
    actor.send({ type: "_agent:start", timestamp: 0 });

    expect(actor.getSnapshot().value).toEqual({
      running: { input: "silent", human: "idle", ai: "idle" },
    });
  });

  it("reaches the final state on stop", () => {
    const actor = createMachineActor();
    actor.start();
    actor.send({ type: "_agent:start", timestamp: 0 });
    actor.send({ type: "_agent:stop", timestamp: 10 });

    expect(actor.getSnapshot().status).toBe("done");
  });
});
