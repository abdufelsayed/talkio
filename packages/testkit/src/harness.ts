import {
  createAgent,
  type Agent,
  type AgentConfig,
  type AgentTraceEvent,
  type AudioConfig,
  type BackchannelConfig,
  type FillerConfig,
  type InterruptionConfig,
  type PublicAgentEvent,
  type TurnDetectorMode,
  type TurnTakingConfig,
} from "talkio";

import { createTestClock, type TestClock } from "./clock";
import { createEventCapture, type EventCapture } from "./event-capture";
import {
  createFakeLLM,
  createFakeSTT,
  createFakeTTS,
  createFakeTurnDetector,
  createFakeVAD,
  type FakeLLM,
  type FakeSTT,
  type FakeTTS,
  type FakeTurnDetector,
  type FakeVAD,
} from "./fake-providers";

export type HarnessOptions = {
  useVAD?: boolean;
  useTurnDetector?: boolean;
  /** Mode of the fake turn detector. @default "decision" */
  turnDetectorMode?: TurnDetectorMode;
  /** Make the fake STT report native turn signals (`stt.turn`). */
  sttTurnDetection?: boolean;
  turnTaking?: TurnTakingConfig;
  interruption?: InterruptionConfig;
  fillers?: FillerConfig;
  backchannels?: BackchannelConfig;
  timeout?: {
    llmMs?: number;
    ttsMs?: number;
  };
  audio?: AudioConfig;
  maxMessages?: number;
  debug?: boolean;
  eventTimeoutMs?: number;
  consumeAudioStream?: boolean;
  onEvent?: (event: PublicAgentEvent) => void;
  onTrace?: (event: AgentTraceEvent) => void;
};

export type AgentHarness = {
  agent: Agent;
  stt: FakeSTT;
  llm: FakeLLM;
  tts: FakeTTS;
  vad?: FakeVAD;
  turnDetector?: FakeTurnDetector;
  events: EventCapture;
  traces: AgentTraceEvent[];
  audioOutput: ArrayBuffer[];
  clock: TestClock["clock"];
  advance: (ms: number) => void;
  stop: () => void;
};

export function createAgentHarness(options: HarnessOptions = {}): AgentHarness {
  const stt = createFakeSTT({ turnDetection: options.sttTurnDetection });
  const llm = createFakeLLM();
  const tts = createFakeTTS();
  const vad = options.useVAD ? createFakeVAD() : undefined;
  const turnDetector = options.useTurnDetector
    ? createFakeTurnDetector({ mode: options.turnDetectorMode })
    : undefined;
  const { clock, advance } = createTestClock();
  const events = createEventCapture({
    defaultTimeoutMs: options.eventTimeoutMs,
    now: () => clock.now(),
  });
  const traces: AgentTraceEvent[] = [];

  const agent = createAgent({
    stt: stt.provider,
    llm: llm.provider,
    tts: tts.provider,
    vad: vad?.provider,
    turnDetector: turnDetector?.provider,
    turnTaking: options.turnTaking,
    interruption: options.interruption,
    fillers: options.fillers,
    backchannels: options.backchannels,
    timeout: options.timeout,
    audio: options.audio,
    maxMessages: options.maxMessages,
    debug: options.debug,
    simulatedClock: clock as unknown as AgentConfig["simulatedClock"],
    observability: {
      level: "trace",
      onTrace: (event) => {
        traces.push(event);
        options.onTrace?.(event);
      },
    },
    onEvent: (event) => {
      events.onEvent(event);
      options.onEvent?.(event);
    },
  });
  const audioOutput: ArrayBuffer[] = [];

  if (options.consumeAudioStream ?? true) {
    const reader = agent.audioStream.getReader();
    void (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          audioOutput.push(chunk.value);
        }
      } catch {
        return;
      }
    })();
  }

  return {
    agent,
    stt,
    llm,
    tts,
    vad,
    turnDetector,
    events,
    traces,
    audioOutput,
    clock,
    advance,
    stop: () => agent.stop(),
  };
}
