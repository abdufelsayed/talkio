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

type LifecycleTurnShape = {
  userText: string;
  completionOrder: "llm-first" | "tts-first";
  interruptAt: "none" | "before-audio" | "after-audio" | "after-llm-complete";
  tokenDelayMs: number;
  sentenceDelayMs: number;
  ttsFirstAudioDelayMs: number;
  ttsCompleteDelayMs: number;
  llmCompleteDelayMs: number;
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
          event: "user-turn:ended",
          partial: { text: turn.userText },
        },
        {
          type: "expect.event",
          event: "agent-turn:started",
        },
      );

      if (turn.outcome === "complete") {
        trace.push(
          { type: "llm.token", token: turn.responseText },
          { type: "llm.sentence", text: turn.responseText, index: 0 },
          { type: "tts.chunk", value: turn.chunkValue, size: turn.chunkSize },
          { type: "llm.complete", text: turn.responseText },
          { type: "tts.complete" },
          { type: "expect.event", event: "agent-turn:ended", partial: { wasSpoken: true } },
        );
      } else if (turn.outcome === "interrupt") {
        trace.push(
          { type: "llm.sentence", text: turn.responseText, index: 0 },
          { type: "tts.chunk", value: turn.chunkValue, size: turn.chunkSize },
          { type: "stt.final", text: turn.interruptText },
          { type: "expect.event", event: "agent-turn:interrupted" },
          { type: "expect.event", event: "agent-turn:started" },
          { type: "tts.complete" },
          { type: "llm.sentence", text: "Recovered.", index: 0 },
          { type: "tts.chunk", value: turn.chunkValue, size: turn.chunkSize },
          { type: "llm.complete", text: "Recovered." },
          { type: "tts.complete" },
          { type: "expect.event", event: "agent-turn:ended" },
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

function aiTurnLifecycleSteps(turn: LifecycleTurnShape): ScenarioTraceStep[] {
  const response = `${turn.userText} response.`;
  const recovery = `${turn.userText} recovery.`;
  const trace: ScenarioTraceStep[] = [
    { type: "stt.final", text: turn.userText },
    { type: "expect.event", event: "user-turn:ended", partial: { text: turn.userText } },
    { type: "expect.event", event: "agent-turn:started" },
    { type: "advance", ms: turn.tokenDelayMs },
    { type: "llm.token", token: response },
    { type: "advance", ms: turn.sentenceDelayMs },
    { type: "llm.sentence", text: response, index: 0 },
  ];

  if (turn.interruptAt === "before-audio") {
    trace.push(
      { type: "stt.speechStart" },
      { type: "expect.event", event: "agent-turn:interruption-pending" },
      { type: "advance", ms: 200 },
      { type: "expect.noEvent", event: "agent-turn:interrupted" },
      { type: "stt.partial", text: "wait a moment" },
      { type: "expect.event", event: "agent-turn:interrupted" },
      { type: "expect.event", event: "user-turn:started" },
      { type: "stt.final", text: `${turn.userText} interrupt` },
      { type: "expect.event", event: "user-turn:ended" },
      { type: "expect.event", event: "agent-turn:started" },
      { type: "llm.sentence", text: recovery, index: 0 },
      { type: "drain" },
      { type: "tts.chunk", value: turn.chunkValue, size: turn.chunkSize },
      { type: "llm.complete", text: recovery },
      { type: "tts.complete" },
      { type: "expect.event", event: "agent-turn:ended" },
    );
    return trace;
  }

  trace.push(
    { type: "advance", ms: turn.ttsFirstAudioDelayMs },
    { type: "tts.chunk", value: turn.chunkValue, size: turn.chunkSize },
  );

  if (turn.interruptAt === "after-audio" || turn.interruptAt === "after-llm-complete") {
    if (turn.interruptAt === "after-llm-complete") {
      trace.push(
        { type: "advance", ms: turn.llmCompleteDelayMs },
        { type: "llm.complete", text: response },
      );
    }
    trace.push(
      { type: "stt.speechStart" },
      { type: "expect.event", event: "agent-turn:interruption-pending" },
      { type: "advance", ms: 200 },
      { type: "expect.noEvent", event: "agent-turn:interrupted" },
      { type: "stt.partial", text: "wait a moment" },
      { type: "expect.event", event: "agent-turn:interrupted" },
      { type: "expect.event", event: "user-turn:started" },
      { type: "stt.final", text: `${turn.userText} interrupt` },
      { type: "expect.event", event: "user-turn:ended" },
      { type: "expect.event", event: "agent-turn:started" },
      { type: "llm.sentence", text: recovery, index: 0 },
      { type: "drain" },
      { type: "tts.chunk", value: turn.chunkValue, size: turn.chunkSize },
      { type: "llm.complete", text: recovery },
      { type: "tts.complete" },
      { type: "expect.event", event: "agent-turn:ended" },
    );
    return trace;
  }

  if (turn.completionOrder === "llm-first") {
    trace.push(
      { type: "advance", ms: turn.llmCompleteDelayMs },
      { type: "llm.complete", text: response },
      { type: "expect.noEvent", event: "agent-turn:ended" },
      { type: "advance", ms: turn.ttsCompleteDelayMs },
      { type: "tts.complete" },
    );
  } else {
    trace.push(
      { type: "advance", ms: turn.ttsCompleteDelayMs },
      { type: "tts.complete" },
      { type: "expect.noEvent", event: "agent-turn:ended" },
      { type: "advance", ms: turn.llmCompleteDelayMs },
      { type: "llm.complete", text: response },
    );
  }

  trace.push({ type: "expect.event", event: "agent-turn:ended" });
  return trace;
}

function aiTurnLifecycleShapeArbitrary(): fc.Arbitrary<LifecycleTurnShape> {
  return fc.record({
    userText: wordArbitrary("life"),
    completionOrder: fc.constantFrom("llm-first", "tts-first"),
    interruptAt: fc.constantFrom("none", "before-audio", "after-audio", "after-llm-complete"),
    tokenDelayMs: fc.integer({ min: 0, max: 120 }),
    sentenceDelayMs: fc.integer({ min: 0, max: 120 }),
    ttsFirstAudioDelayMs: fc.integer({ min: 0, max: 160 }),
    ttsCompleteDelayMs: fc.integer({ min: 0, max: 500 }),
    llmCompleteDelayMs: fc.integer({ min: 0, max: 200 }),
    chunkValue: fc.integer({ min: 0, max: 255 }),
    chunkSize: fc.integer({ min: 2, max: 8 }),
  });
}

export function aiTurnLifecycleTraceArbitrary(
  options: FuzzOptions = {},
): fc.Arbitrary<ScenarioTrace> {
  const minLength = options.turns ?? options.minTurns ?? 1;
  const maxLength = options.turns ?? options.maxTurns ?? 3;
  return fc
    .array(aiTurnLifecycleShapeArbitrary(), { minLength, maxLength })
    .map(
      (turns): ScenarioTrace => [
        { type: "start" },
        { type: "expect.event", event: "agent:started" },
        ...turns.flatMap(aiTurnLifecycleSteps),
        { type: "assert.invariants" },
        { type: "assert.traceInvariants" },
        { type: "assert.latencyBudgets" },
        { type: "stop" },
        { type: "expect.event", event: "agent:stopped" },
      ],
    );
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
        { type: "assert.traceInvariants" },
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
