import {
  createAgent,
  type Agent,
  type AgentConfig,
  type AudioConfig,
  type InterruptionConfig,
  type PublicAgentEvent,
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
  interruption?: InterruptionConfig;
  timeout?: {
    llmMs?: number;
    ttsMs?: number;
  };
  audio?: AudioConfig;
  maxMessages?: number;
  debug?: boolean;
  eventTimeoutMs?: number;
  onEvent?: (event: PublicAgentEvent) => void;
};

export type AgentHarness = {
  agent: Agent;
  stt: FakeSTT;
  llm: FakeLLM;
  tts: FakeTTS;
  vad?: FakeVAD;
  turnDetector?: FakeTurnDetector;
  events: EventCapture;
  clock: TestClock["clock"];
  advance: (ms: number) => void;
  stop: () => void;
};

export function createAgentHarness(options: HarnessOptions = {}): AgentHarness {
  const stt = createFakeSTT();
  const llm = createFakeLLM();
  const tts = createFakeTTS();
  const vad = options.useVAD ? createFakeVAD() : undefined;
  const turnDetector = options.useTurnDetector ? createFakeTurnDetector() : undefined;
  const events = createEventCapture({ defaultTimeoutMs: options.eventTimeoutMs });
  const { clock, advance } = createTestClock();

  const agent = createAgent({
    stt: stt.provider,
    llm: llm.provider,
    tts: tts.provider,
    vad: vad?.provider,
    turnDetector: turnDetector?.provider,
    interruption: options.interruption,
    timeout: options.timeout,
    audio: options.audio,
    maxMessages: options.maxMessages,
    debug: options.debug,
    simulatedClock: clock as unknown as AgentConfig["simulatedClock"],
    onEvent: (event) => {
      events.onEvent(event);
      options.onEvent?.(event);
    },
  });

  return {
    agent,
    stt,
    llm,
    tts,
    vad,
    turnDetector,
    events,
    clock,
    advance,
    stop: () => agent.stop(),
  };
}
