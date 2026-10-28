import { describe, expect, it } from "vitest";

import { normalizeAgentConfig } from "../../src/agent/config";
import type { BackchannelConfig, FillerConfig } from "../../src/types/config";
import { createFakeLLM, createFakeSTT, createFakeTTS } from "../helpers/fake-providers";

function normalize(options: { fillers?: FillerConfig; backchannels?: BackchannelConfig }) {
  return normalizeAgentConfig(
    {
      stt: createFakeSTT().provider,
      llm: createFakeLLM().provider,
      tts: createFakeTTS().provider,
      ...options,
    },
    "test-session",
  );
}

describe("normalizeAgentConfig", () => {
  it("trims phrases and drops blank ones, which would never finish speaking", () => {
    const config = normalize({
      fillers: { phrases: [" Give me a second. ", "  "] },
      backchannels: { phrases: ["", "Got it."] },
    });
    expect(config.fillers.phrases).toEqual(["Give me a second."]);
    expect(config.backchannels.phrases).toEqual(["Got it."]);
  });

  it("falls back to the default phrases when none are usable", () => {
    const config = normalize({ fillers: { phrases: [" "] }, backchannels: { phrases: [] } });
    expect(config.fillers.phrases).toEqual(["One moment.", "Let me check.", "Hmm, let me think."]);
    expect(config.backchannels.phrases).toEqual(["Mm-hmm.", "Uh-huh.", "Okay.", "Right."]);
  });
});
