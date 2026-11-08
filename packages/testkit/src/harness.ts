import {
  createAgent,
  type Agent,
  type AgentConfig,
  type AgentTraceEvent,
  type AudioConfig,
  type PublicAgentEvent,
  type Tool,
  type TurnDetector,
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
  /** What the fake turn detector reports. @default "probability" */
  turnDetectorOutput?: TurnDetector["output"];
  /** Make the fake STT report native turn signals (`stt.turn`). */
  sttTurnDetection?: boolean;
  turnTaking?: TurnTakingConfig;
  interruption?: AgentConfig["interruption"];
  backchannels?: AgentConfig["backchannels"];
  silence?: AgentConfig["silence"];
  instructions?: string;
  /** Adds a fake thinker that can call these tools. */
  tools?: Record<string, Tool>;
  timeout?: {
    talkerMs?: number;
    ttsMs?: number;
  };
  audio?: AudioConfig;
  debug?: boolean;
  eventTimeoutMs?: number;
  consumeAudioStream?: boolean;
  onEvent?: (event: PublicAgentEvent) => void;
  onTrace?: (event: AgentTraceEvent) => void;
};

export type AgentHarness = {
  agent: Agent;
  stt: FakeSTT;
  /** The fake talker. */
  llm: FakeLLM;
  /** The fake thinker, when the harness has `tools`. */
  thinker?: FakeLLM;
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
  const thinker = options.tools ? createFakeLLM() : undefined;
  const tts = createFakeTTS();
  const vad = options.useVAD ? createFakeVAD() : undefined;
  const turnDetector = options.useTurnDetector
    ? createFakeTurnDetector({ output: options.turnDetectorOutput })
    : undefined;
  const { clock, advance } = createTestClock();
  const events = createEventCapture({
    defaultTimeoutMs: options.eventTimeoutMs,
    now: () => clock.now(),
  });
  const traces: AgentTraceEvent[] = [];

  const agent = createAgent({
    stt: stt.provider,
    talker: llm.provider,
    thinker: thinker?.provider,
    instructions: options.instructions,
    tools: options.tools,
    tts: tts.provider,
    vad: vad?.provider,
    turnDetector: turnDetector?.provider,
    turnTaking: options.turnTaking,
    interruption: options.interruption,
    backchannels: options.backchannels,
    silence: options.silence,
    timeout: options.timeout,
    audio: options.audio,
    debug: options.debug,
    clock: clock as unknown as AgentConfig["clock"],
    onTrace: (event) => {
      traces.push(event);
      options.onTrace?.(event);
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
    thinker,
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
