import { describe, expect, it } from "vitest";

import { normalizeAgentConfig } from "../../src/agent/config";
import type { AgentConfig } from "../../src/types/config";
import { createFakeLLM, createFakeSTT, createFakeTTS } from "../helpers/fake-providers";

const talker = createFakeLLM().provider;

function normalize(options: Partial<AgentConfig> = {}) {
  return normalizeAgentConfig(
    {
      stt: createFakeSTT().provider,
      talker,
      tts: createFakeTTS().provider,
      ...options,
    },
    "test-session",
  );
}

describe("normalizeAgentConfig", () => {
  it("trims backchannel phrases and drops blank ones, which would never finish speaking", () => {
    expect(
      normalize({ backchannels: { phrases: ["", " Got it. "] } }).backchannels.phrases,
    ).toEqual(["Got it."]);
  });

  it("falls back to the default backchannel phrases when none are usable", () => {
    expect(normalize({ backchannels: { phrases: [" "] } }).backchannels.phrases).toEqual([
      "Mm-hmm.",
      "Uh-huh.",
      "Okay.",
      "Right.",
    ]);
  });

  it("has no thinker when there are no tools and none is configured", () => {
    const config = normalize();
    expect(config.thinker).toBeUndefined();
    expect(config.tools).toEqual({});
    expect(config.instructions).toBe("");
  });

  it("lets the talker's model think when tools are given without a thinker", () => {
    const tools = { lookup: { inputSchema: {}, execute: () => "found" } };
    expect(normalize({ tools }).thinker).toBe(talker);
  });

  it("keeps a configured thinker", () => {
    const thinker = createFakeLLM().provider;
    expect(normalize({ thinker }).thinker).toBe(thinker);
  });
});
