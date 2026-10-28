import { describe, expectTypeOf, it } from "vitest";

import type { AudioFormat } from "../../src/audio/types";
import {
  createCustomLLMProvider,
  createCustomSTTProvider,
  createCustomTTSProvider,
} from "../../src/providers/factories";
import type { AgentConfig } from "../../src/types/config";

const sttFormats = [{ encoding: "linear16", sampleRate: 16000, channels: 1 }] as const;

type SttFormat = (typeof sttFormats)[number];

const ttsFormats = [{ encoding: "linear16", sampleRate: 24000, channels: 1 }] as const;

type TtsFormat = (typeof ttsFormats)[number];

const stt = createCustomSTTProvider<SttFormat>({
  name: "TypeTestSTT",
  supportedInputFormats: sttFormats,
  defaultInputFormat: sttFormats[0],
  start: () => {},
  stop: () => {},
  sendAudio: () => {},
});

const tts = createCustomTTSProvider<TtsFormat>({
  name: "TypeTestTTS",
  supportedOutputFormats: ttsFormats,
  defaultOutputFormat: ttsFormats[0],
  start: () => {},
  speak: () => {},
  flush: () => {},
  clear: () => {},
  stop: () => {},
});

const llm = createCustomLLMProvider({
  name: "TypeTestLLM",
  generate: (ctx) => {
    void ctx;
  },
});

describe("AgentConfig type inference", () => {
  it("infers audio formats from STT and TTS providers", () => {
    const config: AgentConfig<typeof stt, typeof tts> = {
      stt,
      llm,
      tts,
      audio: {
        input: sttFormats[0],
        output: ttsFormats[0],
      },
    };

    expectTypeOf(config.audio?.input).toEqualTypeOf<SttFormat | undefined>();
    expectTypeOf(config.audio?.output).toEqualTypeOf<TtsFormat | undefined>();
  });

  it("rejects incompatible audio formats", () => {
    const badInput: AudioFormat = { encoding: "mulaw", sampleRate: 8000, channels: 1 };

    const config: AgentConfig<typeof stt, typeof tts> = {
      stt,
      llm,
      tts,
      audio: {
        // @ts-expect-error - unsupported input format for STT provider
        input: badInput,
        output: ttsFormats[0],
      },
    };

    void config;
  });
});
