import {
  type AudioFormat,
  type LLMContext,
  type LLMProvider,
  type Message,
  type NormalizedAudioFormat,
  type ProviderMetadata,
  type STTContext,
  type STTProvider,
  type TTSContext,
  type TTSProvider,
  type TTSWordTiming,
  type Pause,
  type TurnDetector,
  type TurnDetectorContext,
  type TurnDetectorInput,
  type TurnSignals,
  type VADContext,
  type VADProvider,
} from "talkio";
import { normalizeFormat } from "talkio/audio";

import { ScenarioAssertionError } from "./assertions";

type ProviderWithMetadata = {
  readonly metadata: ProviderMetadata;
};

export type ProviderMetadataConformanceOptions = {
  expectedName?: string;
};

export type STTProviderConformanceOptions = ProviderMetadataConformanceOptions;

export type TTSProviderConformanceOptions = ProviderMetadataConformanceOptions;

export type LLMProviderConformanceOptions = ProviderMetadataConformanceOptions;

export type VADProviderConformanceOptions = ProviderMetadataConformanceOptions;

export type TurnDetectorConformanceOptions = { expectedName?: string };

export type TurnSignalRecord =
  | { type: "end"; transcript?: string }
  | { type: "abandoned"; reason: string }
  | { type: "eagerEnd"; transcript?: string }
  | { type: "resumed" }
  | { type: "probability"; probability: number };

export type STTContextProbe = {
  context: STTContext;
  controller: AbortController;
  transcripts: Array<{ text: string; isFinal: boolean }>;
  speechStarts: number;
  speechEnds: number;
  turnSignals: TurnSignalRecord[];
  errors: Error[];
  abort: () => void;
};

export type TTSContextProbe = {
  context: TTSContext;
  controller: AbortController;
  audioChunks: ArrayBuffer[];
  wordTimings: TTSWordTiming[];
  completions: number;
  errors: Error[];
  abort: () => void;
};

export type LLMContextProbe = {
  context: LLMContext;
  controller: AbortController;
  tokens: string[];
  sentences: Array<{ sentence: string; index: number }>;
  completions: Array<string | undefined>;
  fillerTexts: string[];
  interruptions: number;
  errors: Error[];
  abort: () => void;
};

export type VADContextProbe = {
  context: VADContext;
  controller: AbortController;
  speechStarts: number;
  /** Each speech end, with the duration the VAD reported if any. */
  speechEnds: Array<{ duration: number | undefined }>;
  probabilities: number[];
  errors: Error[];
  abort: () => void;
};

export type TurnDetectorContextProbe = {
  context: TurnDetectorContext;
  controller: AbortController;
  turnEnds: Array<string | undefined>;
  abandonedTurns: string[];
  probabilities: number[];
  turnSignals: TurnSignalRecord[];
  errors: Error[];
  /** A pause to pass to `onPause`; aborted with the probe. */
  pause: (transcript: string, messages?: readonly Message[]) => Pause;
  abort: () => void;
};

export type STTProbeSnapshot = {
  transcripts: Array<{ text: string; isFinal: boolean }>;
  speechStarts: number;
  speechEnds: number;
  turnSignals: TurnSignalRecord[];
  errors: string[];
};

export type TTSProbeSnapshot = {
  audioByteLengths: number[];
  completions: number;
  errors: string[];
};

export type LLMProbeSnapshot = {
  tokens: string[];
  sentences: Array<{ sentence: string; index: number }>;
  completions: Array<string | undefined>;
  fillerTexts: string[];
  interruptions: number;
  errors: string[];
};

export type VADProbeSnapshot = {
  speechStarts: number;
  speechEnds: Array<{ duration: number | undefined }>;
  probabilities: number[];
  errors: string[];
};

export type TurnDetectorProbeSnapshot = {
  turnEnds: Array<string | undefined>;
  abandonedTurns: string[];
  turnSignals: TurnSignalRecord[];
  errors: string[];
};

type MaybePromise<T> = T | Promise<T>;

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

function errorMessages(errors: readonly Error[]): string[] {
  return errors.map((error) => error.message);
}

function assertSameSnapshot(actual: unknown, expected: unknown, label: string): void {
  const actualJSON = JSON.stringify(actual);
  const expectedJSON = JSON.stringify(expected);
  assert(
    actualJSON === expectedJSON,
    `${label} emitted after abort. Expected ${expectedJSON} but received ${actualJSON}`,
  );
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

  if (options.expectedName !== undefined) {
    assert(
      metadata.name === options.expectedName,
      `provider.metadata.name expected ${options.expectedName} but received ${metadata.name}`,
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
  assertProviderMetadataConformance(provider, options);
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
  assertProviderMetadataConformance(provider, options);
  assertFormatListConformance(
    provider.metadata.supportedOutputFormats,
    provider.metadata.defaultOutputFormat,
    "tts.metadata",
  );
  assertMethod(provider.start, "tts.start");
  assertMethod(provider.speak, "tts.speak");
  assertMethod(provider.flush, "tts.flush");
  assertMethod(provider.clear, "tts.clear");
  assertMethod(provider.stop, "tts.stop");
}

export function assertLLMProviderConformance(
  provider: LLMProvider,
  options: LLMProviderConformanceOptions = {},
): void {
  assertProviderMetadataConformance(provider, options);
  assertMethod(provider.generate, "llm.generate");
}

export function assertVADProviderConformance(
  provider: VADProvider,
  options: VADProviderConformanceOptions = {},
): void {
  assertProviderMetadataConformance(provider, options);
  assertMethod(provider.start, "vad.start");
  assertMethod(provider.stop, "vad.stop");
  assertMethod(provider.sendAudio, "vad.sendAudio");
}

const TURN_DETECTOR_HOOKS = [
  "start",
  "stop",
  "onPause",
  "sendAudio",
  "onTranscript",
  "onSpeechStart",
] as const;

function assertTurnDetectorObject(
  detector: TurnDetector,
  label: string,
  options: TurnDetectorConformanceOptions,
) {
  assert(
    detector !== null && typeof detector === "object",
    `${label} must be a function or an object`,
  );
  assert(
    detector.name === undefined || typeof detector.name === "string",
    `${label}.name must be a string when present`,
  );
  if (options.expectedName !== undefined) {
    assert(
      detector.name === options.expectedName,
      `${label}.name expected ${options.expectedName} but received ${detector.name}`,
    );
  }
  for (const name of TURN_DETECTOR_HOOKS) {
    if (detector[name] !== undefined) assertMethod(detector[name], `${label}.${name}`);
  }
  const output = detector.output;
  if (output !== undefined && output !== "probability" && output !== "decision") {
    throw new ScenarioAssertionError(`${label}.output must be "probability" or "decision"`);
  }
}

export function assertTurnDetectorConformance(
  detector: TurnDetectorInput,
  options: TurnDetectorConformanceOptions = {},
): void {
  const detectors = Array.isArray(detector) ? detector : [detector];
  detectors.forEach((one: TurnDetector | ((pause: Pause) => unknown), index) => {
    const label = Array.isArray(detector) ? `turnDetector[${index}]` : "turnDetector";
    if (typeof one !== "function") assertTurnDetectorObject(one, label, options);
  });
}

function recordTurnSignals(records: TurnSignalRecord[]): TurnSignals {
  return {
    end: (transcript) => records.push({ type: "end", transcript }),
    abandoned: (reason) => records.push({ type: "abandoned", reason }),
    eagerEnd: (transcript) => records.push({ type: "eagerEnd", transcript }),
    resumed: () => records.push({ type: "resumed" }),
    probability: (probability) => records.push({ type: "probability", probability }),
  };
}

export function createSTTContextProbe(
  options: { audioFormat?: AudioFormat } = {},
): STTContextProbe {
  const controller = new AbortController();
  const transcripts: Array<{ text: string; isFinal: boolean }> = [];
  const turnSignals: TurnSignalRecord[] = [];
  const errors: Error[] = [];
  let speechStarts = 0;
  let speechEnds = 0;
  return {
    context: {
      audioFormat: normalizeFormat(options.audioFormat ?? DEFAULT_INPUT_FORMAT),
      turn: recordTurnSignals(turnSignals),
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
    turnSignals,
    errors,
    abort: () => controller.abort(),
  };
}

export function createTTSContextProbe(
  options: { audioFormat?: AudioFormat } = {},
): TTSContextProbe {
  const controller = new AbortController();
  const audioChunks: ArrayBuffer[] = [];
  const wordTimings: TTSWordTiming[] = [];
  const errors: Error[] = [];
  let completions = 0;

  return {
    context: {
      audioFormat: normalizeFormat(options.audioFormat ?? DEFAULT_OUTPUT_FORMAT),
      audio: (audio) => {
        audioChunks.push(audio);
      },
      wordTimings: (words) => {
        wordTimings.push(...words);
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
    wordTimings,
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
    speculative?: boolean;
    commitment?: Promise<boolean>;
  } = {},
): LLMContextProbe {
  const controller = new AbortController();
  const tokens: string[] = [];
  const sentences: Array<{ sentence: string; index: number }> = [];
  const completions: Array<string | undefined> = [];
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
      isSpeculative: () => options.speculative ?? false,
      turnConfirmed: () => options.commitment ?? Promise.resolve(true),
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

export function createVADContextProbe(
  options: { audioFormat?: AudioFormat } = {},
): VADContextProbe {
  const controller = new AbortController();
  const speechEnds: Array<{ duration: number | undefined }> = [];
  const probabilities: number[] = [];
  const errors: Error[] = [];
  let speechStarts = 0;

  return {
    context: {
      audioFormat: normalizeFormat(options.audioFormat ?? DEFAULT_INPUT_FORMAT),
      speechStart: () => {
        speechStarts++;
      },
      speechEnd: (duration) => {
        speechEnds.push({ duration });
      },
      probability: (probability) => {
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

export function createTurnDetectorContextProbe(
  options: { audioFormat?: AudioFormat } = {},
): TurnDetectorContextProbe {
  const controller = new AbortController();
  const turnSignals: TurnSignalRecord[] = [];
  const errors: Error[] = [];
  const pauses: AbortController[] = [];
  return {
    context: {
      audioFormat: normalizeFormat(options.audioFormat ?? DEFAULT_INPUT_FORMAT),
      turn: recordTurnSignals(turnSignals),
      error: (error) => errors.push(error),
      signal: controller.signal,
    },
    controller,
    get turnEnds() {
      return turnSignals.flatMap((record) => (record.type === "end" ? [record.transcript] : []));
    },
    get abandonedTurns() {
      return turnSignals.flatMap((record) => (record.type === "abandoned" ? [record.reason] : []));
    },
    get probabilities() {
      return turnSignals.flatMap((record) =>
        record.type === "probability" ? [record.probability] : [],
      );
    },
    turnSignals,
    errors,
    pause: (transcript, messages = []) => {
      const pause = new AbortController();
      pauses.push(pause);
      if (controller.signal.aborted) pause.abort();
      return { transcript, messages, signal: pause.signal };
    },
    abort: () => {
      controller.abort();
      for (const pause of pauses) pause.abort();
    },
  };
}

export function snapshotSTTContextProbe(probe: STTContextProbe): STTProbeSnapshot {
  return {
    transcripts: [...probe.transcripts],
    speechStarts: probe.speechStarts,
    speechEnds: probe.speechEnds,
    turnSignals: [...probe.turnSignals],
    errors: errorMessages(probe.errors),
  };
}

export function snapshotTTSContextProbe(probe: TTSContextProbe): TTSProbeSnapshot {
  return {
    audioByteLengths: probe.audioChunks.map((audio) => audio.byteLength),
    completions: probe.completions,
    errors: errorMessages(probe.errors),
  };
}

export function snapshotLLMContextProbe(probe: LLMContextProbe): LLMProbeSnapshot {
  return {
    tokens: [...probe.tokens],
    sentences: [...probe.sentences],
    completions: [...probe.completions],
    fillerTexts: [...probe.fillerTexts],
    interruptions: probe.interruptions,
    errors: errorMessages(probe.errors),
  };
}

export function snapshotVADContextProbe(probe: VADContextProbe): VADProbeSnapshot {
  return {
    speechStarts: probe.speechStarts,
    speechEnds: [...probe.speechEnds],
    probabilities: [...probe.probabilities],
    errors: errorMessages(probe.errors),
  };
}

export function snapshotTurnDetectorContextProbe(
  probe: TurnDetectorContextProbe,
): TurnDetectorProbeSnapshot {
  return {
    turnEnds: [...probe.turnEnds],
    abandonedTurns: [...probe.abandonedTurns],
    turnSignals: [...probe.turnSignals],
    errors: errorMessages(probe.errors),
  };
}

export async function assertNoSTTEventsAfterAbort(
  probe: STTContextProbe,
  exercise: () => MaybePromise<void>,
): Promise<void> {
  probe.abort();
  const before = snapshotSTTContextProbe(probe);
  await exercise();
  assertSameSnapshot(snapshotSTTContextProbe(probe), before, "stt");
}

export async function assertNoTTSEventsAfterAbort(
  probe: TTSContextProbe,
  exercise: () => MaybePromise<void>,
): Promise<void> {
  probe.abort();
  const before = snapshotTTSContextProbe(probe);
  await exercise();
  assertSameSnapshot(snapshotTTSContextProbe(probe), before, "tts");
}

export async function assertNoLLMEventsAfterAbort(
  probe: LLMContextProbe,
  exercise: () => MaybePromise<void>,
): Promise<void> {
  probe.abort();
  const before = snapshotLLMContextProbe(probe);
  await exercise();
  assertSameSnapshot(snapshotLLMContextProbe(probe), before, "llm");
}

export async function assertNoVADEventsAfterAbort(
  probe: VADContextProbe,
  exercise: () => MaybePromise<void>,
): Promise<void> {
  probe.abort();
  const before = snapshotVADContextProbe(probe);
  await exercise();
  assertSameSnapshot(snapshotVADContextProbe(probe), before, "vad");
}

export async function assertNoTurnDetectorEventsAfterAbort(
  probe: TurnDetectorContextProbe,
  exercise: () => MaybePromise<void>,
): Promise<void> {
  probe.abort();
  const before = snapshotTurnDetectorContextProbe(probe);
  await exercise();
  assertSameSnapshot(snapshotTurnDetectorContextProbe(probe), before, "turn detector");
}
