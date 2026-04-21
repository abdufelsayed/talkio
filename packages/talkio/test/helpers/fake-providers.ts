import type { AudioFormat } from "../../src/audio/types";
import {
  createCustomLLMProvider,
  createCustomSTTProvider,
  createCustomTTSProvider,
  createCustomTurnDetectorProvider,
  createCustomVADProvider,
} from "../../src/providers/factories";
import type {
  LLMContext,
  LLMProvider,
  STTContext,
  STTProvider,
  TTSContext,
  TTSProvider,
  TurnDetectorContext,
  TurnDetectorProvider,
  VADContext,
  VADProvider,
} from "../../src/providers/types";
import type { Message } from "../../src/types/common";

type FakeSTT = {
  provider: STTProvider<AudioFormat>;
  receivedAudio: ArrayBuffer[];
  started: boolean;
  stopped: boolean;
  aborted: boolean;
  getContext: () => STTContext | null;
  emitTranscript: (text: string, isFinal: boolean) => void;
  emitSpeechStart: () => void;
  emitSpeechEnd: () => void;
  emitError: (error: Error) => void;
};

type LLMAction =
  | { type: "token"; token: string }
  | { type: "sentence"; sentence: string; index: number }
  | { type: "complete"; text: string }
  | { type: "error"; error: Error }
  | { type: "say"; text: string }
  | { type: "interrupt" };

type FakeLLM = {
  provider: LLMProvider;
  messages: Message[];
  started: boolean;
  aborted: boolean;
  getContext: () => LLMContext | null;
  run: (actions: LLMAction[]) => void;
  emitToken: (token: string) => void;
  emitSentence: (sentence: string, index: number) => void;
  complete: (text: string) => void;
  error: (error: Error) => void;
  say: (text: string) => void;
  interrupt: () => void;
};

type TTSRequest = {
  id: number;
  text: string;
  ctx: TTSContext;
};

type FakeTTS = {
  provider: TTSProvider<AudioFormat>;
  requests: TTSRequest[];
  started: boolean;
  stopped: boolean;
  abortedIds: number[];
  getCurrentRequest: () => TTSRequest | null;
  emitAudio: (audio: ArrayBuffer) => void;
  complete: () => void;
  error: (error: Error) => void;
};

type FakeVAD = {
  provider: VADProvider;
  receivedAudio: ArrayBuffer[];
  started: boolean;
  stopped: boolean;
  aborted: boolean;
  getContext: () => VADContext | null;
  emitSpeechStart: () => void;
  emitSpeechEnd: (duration: number) => void;
  emitProbability: (value: number) => void;
  emitError: (error: Error) => void;
};

type FakeTurnDetector = {
  provider: TurnDetectorProvider;
  receivedTranscripts: Array<{ text: string; isFinal: boolean }>;
  receivedSpeechEnds: number[];
  started: boolean;
  stopped: boolean;
  aborted: boolean;
  getContext: () => TurnDetectorContext | null;
  emitTurnEnd: (transcript: string) => void;
  emitTurnAbandoned: (reason: string) => void;
};

const DEFAULT_INPUT_FORMATS: readonly AudioFormat[] = [
  { encoding: "linear16", sampleRate: 16000, channels: 1 },
];

const DEFAULT_OUTPUT_FORMATS: readonly AudioFormat[] = [
  { encoding: "linear16", sampleRate: 24000, channels: 1 },
];

function attachAbort(signal: AbortSignal, onAbort: () => void): void {
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
}

export function createFakeSTT(options?: {
  supportedInputFormats?: readonly AudioFormat[];
  defaultInputFormat?: AudioFormat;
}): FakeSTT {
  const receivedAudio: ArrayBuffer[] = [];
  let ctx: STTContext | null = null;
  let started = false;
  let stopped = false;
  let aborted = false;

  const supportedInputFormats = options?.supportedInputFormats ?? DEFAULT_INPUT_FORMATS;
  const defaultInputFormat = options?.defaultInputFormat ?? supportedInputFormats[0];

  const provider = createCustomSTTProvider({
    name: "FakeSTT",
    supportedInputFormats,
    defaultInputFormat,
    start: (context) => {
      started = true;
      ctx = context;
      attachAbort(context.signal, () => {
        aborted = true;
      });
    },
    stop: () => {
      stopped = true;
    },
    sendAudio: (audio) => {
      receivedAudio.push(audio);
    },
  });

  return {
    provider,
    receivedAudio,
    getContext: () => ctx,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    get aborted() {
      return aborted;
    },
    emitTranscript: (text, isFinal) => {
      if (!ctx) {
        throw new Error("STT context not initialized");
      }
      ctx.transcript(text, isFinal);
    },
    emitSpeechStart: () => {
      if (!ctx) {
        throw new Error("STT context not initialized");
      }
      ctx.speechStart();
    },
    emitSpeechEnd: () => {
      if (!ctx) {
        throw new Error("STT context not initialized");
      }
      ctx.speechEnd();
    },
    emitError: (error) => {
      if (!ctx) {
        throw new Error("STT context not initialized");
      }
      ctx.error(error);
    },
  };
}

export function createFakeLLM(): FakeLLM {
  let ctx: LLMContext | null = null;
  let messages: Message[] = [];
  let started = false;
  let aborted = false;

  const provider = createCustomLLMProvider({
    name: "FakeLLM",
    generate: (_messages, context) => {
      started = true;
      messages = _messages;
      ctx = context;
      attachAbort(context.signal, () => {
        aborted = true;
      });
    },
  });

  const requireContext = (): LLMContext => {
    if (!ctx) {
      throw new Error("LLM context not initialized");
    }
    return ctx;
  };

  const run = (actions: LLMAction[]): void => {
    const context = requireContext();
    for (const action of actions) {
      switch (action.type) {
        case "token":
          context.token(action.token);
          break;
        case "sentence":
          context.sentence(action.sentence, action.index);
          break;
        case "complete":
          context.complete(action.text);
          break;
        case "error":
          context.error(action.error);
          break;
        case "say":
          context.say(action.text);
          break;
        case "interrupt":
          context.interrupt();
          break;
      }
    }
  };

  return {
    provider,
    get messages() {
      return messages;
    },
    get started() {
      return started;
    },
    get aborted() {
      return aborted;
    },
    getContext: () => ctx,
    run,
    emitToken: (token) => {
      requireContext().token(token);
    },
    emitSentence: (sentence, index) => {
      requireContext().sentence(sentence, index);
    },
    complete: (text) => {
      requireContext().complete(text);
    },
    error: (error) => {
      requireContext().error(error);
    },
    say: (text) => {
      requireContext().say(text);
    },
    interrupt: () => {
      requireContext().interrupt();
    },
  };
}

export function createFakeTTS(options?: {
  supportedOutputFormats?: readonly AudioFormat[];
  defaultOutputFormat?: AudioFormat;
}): FakeTTS {
  const requests: TTSRequest[] = [];
  let started = false;
  let stopped = false;
  let nextId = 1;
  const abortedIds: number[] = [];

  const supportedOutputFormats = options?.supportedOutputFormats ?? DEFAULT_OUTPUT_FORMATS;
  const defaultOutputFormat = options?.defaultOutputFormat ?? supportedOutputFormats[0];

  const provider = createCustomTTSProvider({
    name: "FakeTTS",
    supportedOutputFormats,
    defaultOutputFormat,
    synthesize: (text, context) => {
      started = true;
      const request: TTSRequest = { id: nextId++, text, ctx: context };
      requests.push(request);
      attachAbort(context.signal, () => {
        abortedIds.push(request.id);
      });
    },
  });

  const requireRequest = (): TTSRequest => {
    const current = requests[0];
    if (!current) {
      throw new Error("No pending TTS request");
    }
    return current;
  };

  return {
    provider,
    requests,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    abortedIds,
    getCurrentRequest: () => requests[0] ?? null,
    emitAudio: (audio) => {
      const current = requireRequest();
      current.ctx.audioChunk(audio);
    },
    complete: () => {
      const current = requireRequest();
      current.ctx.complete();
      requests.shift();
      if (requests.length === 0) {
        stopped = true;
      }
    },
    error: (error) => {
      const current = requireRequest();
      current.ctx.error(error);
      requests.shift();
      if (requests.length === 0) {
        stopped = true;
      }
    },
  };
}

export function createFakeVAD(): FakeVAD {
  const receivedAudio: ArrayBuffer[] = [];
  let ctx: VADContext | null = null;
  let started = false;
  let stopped = false;
  let aborted = false;

  const provider = createCustomVADProvider({
    name: "FakeVAD",
    start: (context) => {
      started = true;
      ctx = context;
      attachAbort(context.signal, () => {
        aborted = true;
      });
    },
    stop: () => {
      stopped = true;
    },
    processAudio: (audio) => {
      receivedAudio.push(audio);
    },
  });

  return {
    provider,
    receivedAudio,
    getContext: () => ctx,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    get aborted() {
      return aborted;
    },
    emitSpeechStart: () => {
      if (!ctx) {
        throw new Error("VAD context not initialized");
      }
      ctx.speechStart();
    },
    emitSpeechEnd: (duration) => {
      if (!ctx) {
        throw new Error("VAD context not initialized");
      }
      ctx.speechEnd(duration);
    },
    emitProbability: (value) => {
      if (!ctx) {
        throw new Error("VAD context not initialized");
      }
      ctx.speechProbability(value);
    },
    emitError: (error) => {
      if (!ctx) {
        throw new Error("VAD context not initialized");
      }
      ctx.error(error);
    },
  };
}

export function createFakeTurnDetector(): FakeTurnDetector {
  const receivedTranscripts: Array<{ text: string; isFinal: boolean }> = [];
  const receivedSpeechEnds: number[] = [];
  let ctx: TurnDetectorContext | null = null;
  let started = false;
  let stopped = false;
  let aborted = false;

  const provider = createCustomTurnDetectorProvider({
    name: "FakeTurnDetector",
    start: (context) => {
      started = true;
      ctx = context;
      attachAbort(context.signal, () => {
        aborted = true;
      });
    },
    stop: () => {
      stopped = true;
    },
    onSpeechEnd: (duration) => {
      receivedSpeechEnds.push(duration);
    },
    onTranscript: (text, isFinal) => {
      receivedTranscripts.push({ text, isFinal });
    },
  });

  return {
    provider,
    receivedTranscripts,
    receivedSpeechEnds,
    getContext: () => ctx,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    get aborted() {
      return aborted;
    },
    emitTurnEnd: (transcript) => {
      if (!ctx) {
        throw new Error("Turn detector context not initialized");
      }
      ctx.turnEnd(transcript);
    },
    emitTurnAbandoned: (reason) => {
      if (!ctx) {
        throw new Error("Turn detector context not initialized");
      }
      ctx.turnAbandoned(reason);
    },
  };
}

export type { FakeLLM, FakeSTT, FakeTTS, FakeTurnDetector, FakeVAD, LLMAction, TTSRequest };
