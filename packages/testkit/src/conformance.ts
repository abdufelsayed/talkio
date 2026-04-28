import {
  normalizeFormat,
  type AudioFormat,
  type LLMContext,
  type LLMProvider,
  type Message,
  type NormalizedAudioFormat,
  type ProviderMetadata,
  type ProviderType,
  type STTContext,
  type STTProvider,
  type TTSContext,
  type TTSProvider,
  type TurnDetectorContext,
  type TurnDetectorProvider,
  type VADContext,
  type VADProvider,
} from "talkio";

import { ScenarioAssertionError } from "./assertions";

type ProviderWithMetadata = {
  readonly metadata: ProviderMetadata;
};

export type ProviderMetadataConformanceOptions = {
  expectedName?: string;
  expectedType?: ProviderType;
  requireVersion?: boolean;
};

export type STTProviderConformanceOptions = Omit<
  ProviderMetadataConformanceOptions,
  "expectedType"
>;

export type TTSProviderConformanceOptions = Omit<
  ProviderMetadataConformanceOptions,
  "expectedType"
>;

export type LLMProviderConformanceOptions = Omit<
  ProviderMetadataConformanceOptions,
  "expectedType"
>;

export type VADProviderConformanceOptions = Omit<
  ProviderMetadataConformanceOptions,
  "expectedType"
>;

export type TurnDetectorProviderConformanceOptions = Omit<
  ProviderMetadataConformanceOptions,
  "expectedType"
>;

export type STTContextProbe = {
  context: STTContext;
  controller: AbortController;
  transcripts: Array<{ text: string; isFinal: boolean }>;
  speechStarts: number;
  speechEnds: number;
  errors: Error[];
  abort: () => void;
};

export type TTSContextProbe = {
  context: TTSContext;
  controller: AbortController;
  audioChunks: ArrayBuffer[];
  completions: number;
  errors: Error[];
  abort: () => void;
};

export type LLMContextProbe = {
  context: LLMContext;
  controller: AbortController;
  tokens: string[];
  sentences: Array<{ sentence: string; index: number }>;
  completions: string[];
  fillerTexts: string[];
  interruptions: number;
  errors: Error[];
  abort: () => void;
};

export type VADContextProbe = {
  context: VADContext;
  controller: AbortController;
  speechStarts: number;
  speechEnds: Array<{ duration: number }>;
  probabilities: number[];
  errors: Error[];
  abort: () => void;
};

export type TurnDetectorContextProbe = {
  context: TurnDetectorContext;
  controller: AbortController;
  turnEnds: string[];
  abandonedTurns: string[];
  abort: () => void;
};

const DEFAULT_INPUT_FORMAT: NormalizedAudioFormat = {
  encoding: "linear16",
  sampleRate: 16000,
  channels: 1,
};

const DEFAULT_OUTPUT_FORMAT: NormalizedAudioFormat = {
  encoding: "linear16",
  sampleRate: 24000,
  channels: 1,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioAssertionError(message);
}

function assertMethod(value: unknown, label: string): void {
  assert(typeof value === "function", `${label} must be a function`);
}

function formatKey(format: AudioFormat): string {
  return `${format.encoding}:${format.sampleRate ?? "default"}:${format.channels ?? "default"}`;
}

function formatsMatch(left: AudioFormat, right: AudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels
  );
}

export function assertAudioFormatConformance(format: AudioFormat, label: string): void {
  assert(typeof format.encoding === "string" && format.encoding.length > 0, `${label}.encoding`);

  if (format.sampleRate !== undefined) {
    assert(
      Number.isInteger(format.sampleRate) && format.sampleRate > 0,
      `${label}.sampleRate must be a positive integer`,
    );
  }

  if (format.channels !== undefined) {
    assert(
      Number.isInteger(format.channels) && format.channels > 0,
      `${label}.channels must be a positive integer`,
    );
  }
}

export function assertProviderMetadataConformance(
  provider: ProviderWithMetadata,
  options: ProviderMetadataConformanceOptions = {},
): void {
  const { metadata } = provider;

  assert(metadata && typeof metadata === "object", "provider.metadata must exist");
  assert(
    metadata.name === undefined || typeof metadata.name === "string",
    "provider.metadata.name must be a string when present",
  );
  assert(
    metadata.version === undefined || typeof metadata.version === "string",
    "provider.metadata.version must be a string when present",
  );
  assert(typeof metadata.type === "string", "provider.metadata.type must be a string");

  if (options.expectedName !== undefined) {
    assert(
      metadata.name === options.expectedName,
      `provider.metadata.name expected ${options.expectedName} but received ${metadata.name}`,
    );
  }

  if (options.expectedType !== undefined) {
    assert(
      metadata.type === options.expectedType,
      `provider.metadata.type expected ${options.expectedType} but received ${metadata.type}`,
    );
  }

  if (options.requireVersion) {
    assert(
      typeof metadata.version === "string" && metadata.version.length > 0,
      "provider.metadata.version is required",
    );
  }
}

export function assertFormatListConformance(
  formats: readonly AudioFormat[],
  defaultFormat: AudioFormat,
  label: string,
): void {
  assert(Array.isArray(formats), `${label}.supportedFormats must be an array`);
  assert(formats.length > 0, `${label}.supportedFormats must not be empty`);

  const seen = new Set<string>();
  for (const [index, format] of formats.entries()) {
    assertAudioFormatConformance(format, `${label}.supportedFormats[${index}]`);
    const key = formatKey(format);
    assert(!seen.has(key), `${label}.supportedFormats contains duplicate ${key}`);
    seen.add(key);
  }

  assertAudioFormatConformance(defaultFormat, `${label}.defaultFormat`);
  assert(
    formats.some((format) => formatsMatch(format, defaultFormat)),
    `${label}.defaultFormat must be included in supportedFormats`,
  );
}

export function assertSTTProviderConformance(
  provider: STTProvider,
  options: STTProviderConformanceOptions = {},
): void {
  assertProviderMetadataConformance(provider, { ...options, expectedType: "stt" });
  assertFormatListConformance(
    provider.metadata.supportedInputFormats,
    provider.metadata.defaultInputFormat,
    "stt.metadata",
  );
  assertMethod(provider.start, "stt.start");
  assertMethod(provider.stop, "stt.stop");
  assertMethod(provider.sendAudio, "stt.sendAudio");
}

export function assertTTSProviderConformance(
  provider: TTSProvider,
  options: TTSProviderConformanceOptions = {},
): void {
  assertProviderMetadataConformance(provider, { ...options, expectedType: "tts" });
  assertFormatListConformance(
    provider.metadata.supportedOutputFormats,
    provider.metadata.defaultOutputFormat,
    "tts.metadata",
  );
  assertMethod(provider.synthesize, "tts.synthesize");
}

export function assertLLMProviderConformance(
  provider: LLMProvider,
  options: LLMProviderConformanceOptions = {},
): void {
  assertProviderMetadataConformance(provider, { ...options, expectedType: "llm" });
  assertMethod(provider.generate, "llm.generate");
}

export function assertVADProviderConformance(
  provider: VADProvider,
  options: VADProviderConformanceOptions = {},
): void {
  assertProviderMetadataConformance(provider, { ...options, expectedType: "vad" });
  assertMethod(provider.start, "vad.start");
  assertMethod(provider.stop, "vad.stop");
  assertMethod(provider.processAudio, "vad.processAudio");
}

export function assertTurnDetectorProviderConformance(
  provider: TurnDetectorProvider,
  options: TurnDetectorProviderConformanceOptions = {},
): void {
  assertProviderMetadataConformance(provider, { ...options, expectedType: "turn-detector" });
  assertMethod(provider.start, "turnDetector.start");
  assertMethod(provider.stop, "turnDetector.stop");
  assertMethod(provider.onSpeechEnd, "turnDetector.onSpeechEnd");
  assertMethod(provider.onTranscript, "turnDetector.onTranscript");
}

export function createSTTContextProbe(
  options: { audioFormat?: AudioFormat } = {},
): STTContextProbe {
  const controller = new AbortController();
  const transcripts: Array<{ text: string; isFinal: boolean }> = [];
  const errors: Error[] = [];
  let speechStarts = 0;
  let speechEnds = 0;

  return {
    context: {
      audioFormat: normalizeFormat(options.audioFormat ?? DEFAULT_INPUT_FORMAT),
      transcript: (text, isFinal) => {
        transcripts.push({ text, isFinal });
      },
      speechStart: () => {
        speechStarts++;
      },
      speechEnd: () => {
        speechEnds++;
      },
      error: (error) => {
        errors.push(error);
      },
      signal: controller.signal,
    },
    controller,
    transcripts,
    get speechStarts() {
      return speechStarts;
    },
    get speechEnds() {
      return speechEnds;
    },
    errors,
    abort: () => controller.abort(),
  };
}

export function createTTSContextProbe(
  options: { audioFormat?: AudioFormat } = {},
): TTSContextProbe {
  const controller = new AbortController();
  const audioChunks: ArrayBuffer[] = [];
  const errors: Error[] = [];
  let completions = 0;

  return {
    context: {
      audioFormat: normalizeFormat(options.audioFormat ?? DEFAULT_OUTPUT_FORMAT),
      audioChunk: (audio) => {
        audioChunks.push(audio);
      },
      complete: () => {
        completions++;
      },
      error: (error) => {
        errors.push(error);
      },
      signal: controller.signal,
    },
    controller,
    audioChunks,
    get completions() {
      return completions;
    },
    errors,
    abort: () => controller.abort(),
  };
}

export function createLLMContextProbe(
  options: {
    messages?: Message[];
    isSpeaking?: boolean;
  } = {},
): LLMContextProbe {
  const controller = new AbortController();
  const tokens: string[] = [];
  const sentences: Array<{ sentence: string; index: number }> = [];
  const completions: string[] = [];
  const fillerTexts: string[] = [];
  const errors: Error[] = [];
  let interruptions = 0;

  return {
    context: {
      messages: options.messages ?? [],
      say: (text) => {
        fillerTexts.push(text);
      },
      interrupt: () => {
        interruptions++;
      },
      isSpeaking: () => options.isSpeaking ?? false,
      token: (token) => {
        tokens.push(token);
      },
      sentence: (sentence, index) => {
        sentences.push({ sentence, index });
      },
      complete: (text) => {
        completions.push(text);
      },
      error: (error) => {
        errors.push(error);
      },
      signal: controller.signal,
    },
    controller,
    tokens,
    sentences,
    completions,
    fillerTexts,
    get interruptions() {
      return interruptions;
    },
    errors,
    abort: () => controller.abort(),
  };
}

export function createVADContextProbe(): VADContextProbe {
  const controller = new AbortController();
  const speechEnds: Array<{ duration: number }> = [];
  const probabilities: number[] = [];
  const errors: Error[] = [];
  let speechStarts = 0;

  return {
    context: {
      speechStart: () => {
        speechStarts++;
      },
      speechEnd: (duration) => {
        speechEnds.push({ duration });
      },
      speechProbability: (probability) => {
        probabilities.push(probability);
      },
      error: (error) => {
        errors.push(error);
      },
      signal: controller.signal,
    },
    controller,
    get speechStarts() {
      return speechStarts;
    },
    speechEnds,
    probabilities,
    errors,
    abort: () => controller.abort(),
  };
}

export function createTurnDetectorContextProbe(): TurnDetectorContextProbe {
  const controller = new AbortController();
  const turnEnds: string[] = [];
  const abandonedTurns: string[] = [];

  return {
    context: {
      turnEnd: (transcript) => {
        turnEnds.push(transcript);
      },
      turnAbandoned: (reason) => {
        abandonedTurns.push(reason);
      },
      signal: controller.signal,
    },
    controller,
    turnEnds,
    abandonedTurns,
    abort: () => controller.abort(),
  };
}
