import type { AgentState, PublicAgentEvent } from "talkio";

import {
  assertPartialMatch,
  assertSnapshotPartial,
  ScenarioAssertionError,
  type EventType,
} from "./assertions";
import { makeAudioChunk, type AudioChunkInput } from "./audio";
import { drainMicrotasks } from "./clock";
import { createAgentHarness, type AgentHarness, type HarnessOptions } from "./harness";

export type EventExpectation<T extends EventType> =
  | Partial<PublicAgentEvent & { type: T }>
  | ((event: PublicAgentEvent & { type: T }) => boolean | void);

export type SnapshotExpectation =
  | Partial<AgentState>
  | ((snapshot: AgentState, harness: AgentHarness) => boolean | void);

type ScenarioContext = AgentHarness & {
  readIndex: number;
  defaultTimeoutMs: number;
};

type ScenarioStep = {
  name: string;
  run: (context: ScenarioContext) => void | Promise<void>;
};

export type ScenarioResult = AgentHarness;

export class VoiceScenario {
  private readonly steps: ScenarioStep[] = [];
  private readonly harness: AgentHarness;
  private readonly defaultTimeoutMs: number;

  constructor(options: HarnessOptions = {}) {
    this.harness = createAgentHarness(options);
    this.defaultTimeoutMs = options.eventTimeoutMs ?? 1000;
  }

  step(name: string, run: (context: ScenarioContext) => void | Promise<void>): this {
    this.steps.push({ name, run });
    return this;
  }

  start(): this {
    return this.step("start", ({ agent }) => {
      agent.start();
    });
  }

  stop(): this {
    return this.step("stop", ({ agent }) => {
      agent.stop();
    });
  }

  sendAudio(audio: AudioChunkInput = 1, size = 1): this {
    return this.step("sendAudio", ({ agent }) => {
      agent.sendAudio(makeAudioChunk(audio, size));
    });
  }

  advance(ms: number): this {
    return this.step("advance", ({ advance }) => {
      advance(ms);
    });
  }

  drain(): this {
    return this.step("drain", async () => {
      await drainMicrotasks();
    });
  }

  sttPartial(text: string): this {
    return this.step("stt.partial", ({ stt }) => {
      stt.emitTranscript(text, false);
    });
  }

  sttFinal(text: string): this {
    return this.step("stt.final", ({ stt }) => {
      stt.emitTranscript(text, true);
    });
  }

  sttSpeechStart(): this {
    return this.step("stt.speechStart", ({ stt }) => {
      stt.emitSpeechStart();
    });
  }

  sttSpeechEnd(): this {
    return this.step("stt.speechEnd", ({ stt }) => {
      stt.emitSpeechEnd();
    });
  }

  sttError(error: Error): this {
    return this.step("stt.error", ({ stt }) => {
      stt.emitError(error);
    });
  }

  vadSpeechStart(): this {
    return this.step("vad.speechStart", ({ vad }) => {
      if (!vad) throw new ScenarioAssertionError("Scenario was not created with useVAD: true");
      vad.emitSpeechStart();
    });
  }

  vadSpeechEnd(duration: number): this {
    return this.step("vad.speechEnd", ({ vad }) => {
      if (!vad) throw new ScenarioAssertionError("Scenario was not created with useVAD: true");
      vad.emitSpeechEnd(duration);
    });
  }

  vadProbability(value: number): this {
    return this.step("vad.probability", ({ vad }) => {
      if (!vad) throw new ScenarioAssertionError("Scenario was not created with useVAD: true");
      vad.emitProbability(value);
    });
  }

  vadError(error: Error): this {
    return this.step("vad.error", ({ vad }) => {
      if (!vad) throw new ScenarioAssertionError("Scenario was not created with useVAD: true");
      vad.emitError(error);
    });
  }

  turnEnd(transcript: string): this {
    return this.step("turn.end", ({ turnDetector }) => {
      if (!turnDetector) {
        throw new ScenarioAssertionError("Scenario was not created with useTurnDetector: true");
      }
      turnDetector.emitTurnEnd(transcript);
    });
  }

  turnAbandoned(reason: string): this {
    return this.step("turn.abandoned", ({ turnDetector }) => {
      if (!turnDetector) {
        throw new ScenarioAssertionError("Scenario was not created with useTurnDetector: true");
      }
      turnDetector.emitTurnAbandoned(reason);
    });
  }

  llmToken(token: string): this {
    return this.step("llm.token", ({ llm }) => {
      llm.emitToken(token);
    });
  }

  llmSentence(sentence: string, index = 0): this {
    return this.step("llm.sentence", ({ llm }) => {
      llm.emitSentence(sentence, index);
    });
  }

  llmComplete(text: string): this {
    return this.step("llm.complete", ({ llm }) => {
      llm.complete(text);
    });
  }

  llmError(error: Error): this {
    return this.step("llm.error", ({ llm }) => {
      llm.error(error);
    });
  }

  llmSay(text: string): this {
    return this.step("llm.say", ({ llm }) => {
      llm.say(text);
    });
  }

  llmInterrupt(): this {
    return this.step("llm.interrupt", ({ llm }) => {
      llm.interrupt();
    });
  }

  ttsChunk(audio: AudioChunkInput = 1, size = 1): this {
    return this.step("tts.chunk", ({ tts }) => {
      tts.emitAudio(makeAudioChunk(audio, size));
    });
  }

  ttsComplete(): this {
    return this.step("tts.complete", ({ tts }) => {
      tts.complete();
    });
  }

  ttsError(error: Error): this {
    return this.step("tts.error", ({ tts }) => {
      tts.error(error);
    });
  }

  expectEvent<T extends EventType>(
    type: T,
    expectation?: EventExpectation<T>,
    options?: { timeoutMs?: number },
  ): this {
    return this.step(`expect.event:${type}`, async (context) => {
      const recorded = await context.events.waitForRecordedEvent(type, {
        fromIndex: context.readIndex,
        timeoutMs: options?.timeoutMs ?? context.defaultTimeoutMs,
      });
      context.readIndex = recorded.index + 1;

      if (!expectation) return;
      if (typeof expectation === "function") {
        const result = expectation(recorded.event);
        if (result === false) {
          throw new ScenarioAssertionError(`Expectation function returned false for ${type}`);
        }
        return;
      }

      assertPartialMatch(
        recorded.event as unknown as Record<string, unknown>,
        expectation as Record<string, unknown>,
        type,
      );
    });
  }

  expectNoEvent(type: EventType): this {
    return this.step(`expect.noEvent:${type}`, ({ events, readIndex }) => {
      const found = events.findEvent(type, readIndex);
      if (found) {
        throw new ScenarioAssertionError(`Expected no ${type} event after index ${readIndex}`);
      }
    });
  }

  expectSnapshot(expectation: SnapshotExpectation): this {
    return this.step("expect.snapshot", (context) => {
      const snapshot = context.agent.getSnapshot();
      if (typeof expectation === "function") {
        const result = expectation(snapshot, context);
        if (result === false) {
          throw new ScenarioAssertionError("Snapshot expectation function returned false");
        }
        return;
      }
      assertSnapshotPartial(snapshot, expectation);
    });
  }

  expectSequence(types: EventType[]): this {
    return this.step("expect.sequence", ({ events }) => {
      events.assertSequence(types);
    });
  }

  assertInvariants(): this {
    return this.step("assert.invariants", ({ events }) => {
      events.assertInvariants();
    });
  }

  async run(): Promise<ScenarioResult> {
    const context: ScenarioContext = {
      ...this.harness,
      readIndex: 0,
      defaultTimeoutMs: this.defaultTimeoutMs,
    };

    for (const scenarioStep of this.steps) {
      try {
        await scenarioStep.run(context);
      } catch (error) {
        if (error instanceof ScenarioAssertionError) {
          throw new ScenarioAssertionError(`${scenarioStep.name}: ${error.message}`);
        }
        throw error;
      }
    }

    return this.harness;
  }
}

export function createScenario(options: HarnessOptions = {}): VoiceScenario {
  return new VoiceScenario(options);
}

export const scenario = createScenario;
