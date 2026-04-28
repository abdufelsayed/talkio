import type { AgentState } from "talkio";

import type { EventType } from "./assertions";
import type { HarnessOptions } from "./harness";
import { createScenario, type ScenarioResult, type VoiceScenario } from "./scenario";

export type ScenarioTraceStep =
  | { type: "start" }
  | { type: "stop" }
  | { type: "sendAudio"; value?: number; size?: number }
  | { type: "advance"; ms: number }
  | { type: "drain" }
  | { type: "stt.partial"; text: string }
  | { type: "stt.final"; text: string }
  | { type: "stt.speechStart" }
  | { type: "stt.speechEnd" }
  | { type: "stt.error"; message: string }
  | { type: "vad.speechStart" }
  | { type: "vad.speechEnd"; duration: number }
  | { type: "vad.probability"; value: number }
  | { type: "vad.error"; message: string }
  | { type: "turn.end"; transcript: string }
  | { type: "turn.abandoned"; reason: string }
  | { type: "llm.token"; token: string }
  | { type: "llm.sentence"; text: string; index?: number }
  | { type: "llm.complete"; text: string }
  | { type: "llm.error"; message: string }
  | { type: "llm.say"; text: string }
  | { type: "llm.interrupt" }
  | { type: "tts.chunk"; value?: number; size?: number }
  | { type: "tts.complete" }
  | { type: "tts.error"; message: string }
  | { type: "expect.event"; event: EventType; partial?: Record<string, unknown> }
  | { type: "expect.noEvent"; event: EventType }
  | { type: "expect.snapshot"; partial: Partial<AgentState> }
  | { type: "expect.sequence"; events: EventType[] }
  | { type: "assert.invariants" };

export type ScenarioTrace = readonly ScenarioTraceStep[];

export function scenarioFromTrace(
  trace: ScenarioTrace,
  options: HarnessOptions = {},
): VoiceScenario {
  const scenario = createScenario(options);

  for (const step of trace) {
    switch (step.type) {
      case "start":
        scenario.start();
        break;
      case "stop":
        scenario.stop();
        break;
      case "sendAudio":
        scenario.sendAudio(step.value, step.size);
        break;
      case "advance":
        scenario.advance(step.ms);
        break;
      case "drain":
        scenario.drain();
        break;
      case "stt.partial":
        scenario.sttPartial(step.text);
        break;
      case "stt.final":
        scenario.sttFinal(step.text);
        break;
      case "stt.speechStart":
        scenario.sttSpeechStart();
        break;
      case "stt.speechEnd":
        scenario.sttSpeechEnd();
        break;
      case "stt.error":
        scenario.sttError(new Error(step.message));
        break;
      case "vad.speechStart":
        scenario.vadSpeechStart();
        break;
      case "vad.speechEnd":
        scenario.vadSpeechEnd(step.duration);
        break;
      case "vad.probability":
        scenario.vadProbability(step.value);
        break;
      case "vad.error":
        scenario.vadError(new Error(step.message));
        break;
      case "turn.end":
        scenario.turnEnd(step.transcript);
        break;
      case "turn.abandoned":
        scenario.turnAbandoned(step.reason);
        break;
      case "llm.token":
        scenario.llmToken(step.token);
        break;
      case "llm.sentence":
        scenario.llmSentence(step.text, step.index);
        break;
      case "llm.complete":
        scenario.llmComplete(step.text);
        break;
      case "llm.error":
        scenario.llmError(new Error(step.message));
        break;
      case "llm.say":
        scenario.llmSay(step.text);
        break;
      case "llm.interrupt":
        scenario.llmInterrupt();
        break;
      case "tts.chunk":
        scenario.ttsChunk(step.value, step.size);
        break;
      case "tts.complete":
        scenario.ttsComplete();
        break;
      case "tts.error":
        scenario.ttsError(new Error(step.message));
        break;
      case "expect.event":
        scenario.expectEvent(step.event, step.partial);
        break;
      case "expect.noEvent":
        scenario.expectNoEvent(step.event);
        break;
      case "expect.snapshot":
        scenario.expectSnapshot(step.partial);
        break;
      case "expect.sequence":
        scenario.expectSequence(step.events);
        break;
      case "assert.invariants":
        scenario.assertInvariants();
        break;
    }
  }

  return scenario;
}

export async function runTrace(
  trace: ScenarioTrace,
  options: HarnessOptions = {},
): Promise<ScenarioResult> {
  return scenarioFromTrace(trace, options).run();
}
