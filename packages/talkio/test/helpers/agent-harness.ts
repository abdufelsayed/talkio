import { SimulatedClock } from "xstate";

import { createAgent } from "../../src";
import type { TurnDetectorMode } from "../../src/providers/types";
import type {
  BackchannelConfig,
  FillerConfig,
  InterruptionConfig,
  PlaybackConfig,
  TurnTakingConfig,
} from "../../src/types/config";
import type { PublicAgentEvent } from "../../src/types/events";
import {
  createFakeLLM,
  createFakeSTT,
  createFakeTTS,
  createFakeTurnDetector,
  createFakeVAD,
} from "./fake-providers";

export type TestAgentOptions = {
  vad?: boolean;
  turnDetector?: boolean;
  turnDetectorMode?: TurnDetectorMode;
  sttTurnDetection?: boolean;
  turnTaking?: TurnTakingConfig;
  playback?: PlaybackConfig;
  interruption?: InterruptionConfig;
  fillers?: FillerConfig;
  backchannels?: BackchannelConfig;
};

export function createTestAgent(options: TestAgentOptions = {}) {
  const stt = createFakeSTT({ turnDetection: options.sttTurnDetection });
  const llm = createFakeLLM();
  const tts = createFakeTTS();
  const vad = options.vad ? createFakeVAD() : undefined;
  const turnDetector = options.turnDetector
    ? createFakeTurnDetector({ mode: options.turnDetectorMode })
    : undefined;
  const clock = new SimulatedClock();
  const events: PublicAgentEvent[] = [];

  const agent = createAgent({
    stt: stt.provider,
    llm: llm.provider,
    tts: tts.provider,
    vad: vad?.provider,
    turnDetector: turnDetector?.provider,
    turnTaking: options.turnTaking,
    playback: options.playback,
    interruption: options.interruption,
    fillers: options.fillers,
    backchannels: options.backchannels,
    simulatedClock: clock,
    onEvent: (event) => events.push(event),
  });

  const ofType = <T extends PublicAgentEvent["type"]>(type: T) =>
    events.filter((event): event is PublicAgentEvent & { type: T } => event.type === type);

  return { agent, stt, llm, tts, vad, turnDetector, clock, events, ofType };
}

export type TestAgent = ReturnType<typeof createTestAgent>;

/** Byte values of a buffer; vitest treats any two ArrayBuffers as equal, so compare these. */
export function bytesOf(buffer: ArrayBuffer | undefined): number[] | undefined {
  return buffer ? Array.from(new Uint8Array(buffer)) : undefined;
}

export function audioChunk(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes.length > 0 ? bytes : [1]).buffer;
}

/** Starts the agent and gets it audibly speaking `sentence` in reply to "hello". */
export function startSpeaking(harness: TestAgent, sentence = "Hello there."): void {
  harness.agent.start();
  harness.stt.emitTranscript("hello", true);
  harness.llm.emitToken(sentence);
  harness.llm.emitSentence(sentence, 0);
  harness.tts.emitAudio(audioChunk(1, 2));
}
