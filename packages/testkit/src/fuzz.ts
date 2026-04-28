import * as fc from "fast-check";

import type { ScenarioTrace, ScenarioTraceStep } from "./trace";

export type FuzzOptions = {
  seed?: number;
  turns?: number;
  minTurns?: number;
  maxTurns?: number;
};

export type GeneratedScenarioTrace = {
  seed: number;
  trace: ScenarioTrace;
};

type TurnShape = {
  userText: string;
  partial: boolean;
  outcome: "complete" | "interrupt" | "llm-error" | "tts-error";
  responseText: string;
  interruptText: string;
  chunkValue: number;
  chunkSize: number;
};

function wordArbitrary(prefix: string): fc.Arbitrary<string> {
  return fc.integer({ min: 0, max: 9999 }).map((value) => `${prefix}-${value}`);
}

function turnArbitrary(): fc.Arbitrary<ScenarioTraceStep[]> {
  return fc
    .record<TurnShape>({
      userText: wordArbitrary("user"),
      partial: fc.boolean(),
      outcome: fc.constantFrom("complete", "interrupt", "llm-error", "tts-error"),
      responseText: wordArbitrary("ai").map((text) => `${text}.`),
      interruptText: wordArbitrary("interrupt"),
      chunkValue: fc.integer({ min: 0, max: 255 }),
      chunkSize: fc.integer({ min: 2, max: 8 }),
    })
    .map((turn) => {
      const trace: ScenarioTraceStep[] = [];
      if (turn.partial) {
        const partialText = turn.userText.slice(0, Math.max(1, turn.userText.length - 2));
        trace.push({ type: "stt.partial", text: partialText });
      }
      trace.push(
        {
          type: "stt.final",
          text: turn.userText,
        },
        {
          type: "expect.event",
          event: "human-turn:ended",
          partial: { transcript: turn.userText },
        },
        {
          type: "expect.event",
          event: "ai-turn:started",
        },
      );

      if (turn.outcome === "complete") {
        trace.push(
          { type: "llm.token", token: turn.responseText },
          { type: "llm.sentence", text: turn.responseText, index: 0 },
          { type: "tts.chunk", value: turn.chunkValue, size: turn.chunkSize },
          { type: "llm.complete", text: turn.responseText },
          { type: "tts.complete" },
          { type: "expect.event", event: "ai-turn:ended", partial: { wasSpoken: true } },
        );
      } else if (turn.outcome === "interrupt") {
        trace.push(
          { type: "llm.sentence", text: turn.responseText, index: 0 },
          { type: "tts.chunk", value: turn.chunkValue, size: turn.chunkSize },
          { type: "stt.final", text: turn.interruptText },
          { type: "expect.event", event: "ai-turn:interrupted" },
          { type: "expect.event", event: "ai-turn:started" },
          { type: "tts.complete" },
          { type: "llm.sentence", text: "Recovered.", index: 0 },
          { type: "tts.chunk", value: turn.chunkValue, size: turn.chunkSize },
          { type: "llm.complete", text: "Recovered." },
          { type: "tts.complete" },
          { type: "expect.event", event: "ai-turn:ended" },
        );
      } else if (turn.outcome === "llm-error") {
        trace.push(
          { type: "llm.error", message: "generated llm failure" },
          { type: "expect.event", event: "agent:error", partial: { source: "llm" } },
        );
      } else {
        trace.push(
          { type: "llm.sentence", text: turn.responseText, index: 0 },
          { type: "tts.error", message: "generated tts failure" },
          { type: "expect.event", event: "agent:error", partial: { source: "tts" } },
        );
      }

      return trace;
    });
}

export function scenarioTraceArbitrary(options: FuzzOptions = {}): fc.Arbitrary<ScenarioTrace> {
  const minLength = options.turns ?? options.minTurns ?? 1;
  const maxLength = options.turns ?? options.maxTurns ?? 4;
  return fc
    .array(turnArbitrary(), { minLength, maxLength })
    .map(
      (turns): ScenarioTrace => [
        { type: "start" },
        { type: "expect.event", event: "agent:started" },
        ...turns.flat(),
        { type: "stop" },
        { type: "expect.event", event: "agent:stopped" },
        { type: "assert.invariants" },
      ],
    );
}

export function sampleScenarioTrace(options: FuzzOptions = {}): GeneratedScenarioTrace {
  const seed = options.seed ?? Date.now();
  const [trace] = fc.sample(scenarioTraceArbitrary(options), { numRuns: 1, seed });
  if (!trace) {
    throw new Error("fast-check did not produce a scenario trace");
  }
  return { seed, trace };
}

export function generateScenarioTrace(options: FuzzOptions = {}): GeneratedScenarioTrace {
  return sampleScenarioTrace(options);
}
