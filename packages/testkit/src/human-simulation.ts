import * as fc from "fast-check";

import { makeAudioChunk } from "./audio";
import { drainMicrotasks } from "./clock";
import { createAgentHarness, type AgentHarness } from "./harness";

export type HumanSimulationOptions = {
  runs?: number;
  seed?: number;
  interruptionMinDurationMs?: number;
};

export type HumanSimulationThresholds = {
  maxFalseInterruptions: number;
  maxMissedInterruptions: number;
  maxStaleAudioAfterInterruption: number;
  maxUnexpectedAIStarts: number;
  maxSpeculativeCutoffLatencyMs: number;
  maxBargeInLatencyMs: number;
  maxP95EndOfTurnLatencyMs: number;
  maxP95TimeToFirstAudioMs: number;
};

export type HumanSimulationScore = {
  seed: number;
  runs: number;
  completedTurns: number;
  interruptedTurns: number;
  backchannelTurns: number;
  speculativeCutoffs: number;
  cancelledSpeculativeCutoffs: number;
  falseInterruptions: number;
  missedInterruptions: number;
  staleAudioAfterInterruption: number;
  unexpectedAIStarts: number;
  averageSpeculativeCutoffLatencyMs: number;
  maxSpeculativeCutoffLatencyMs: number;
  averageEndOfTurnLatencyMs: number;
  p95EndOfTurnLatencyMs: number;
  maxEndOfTurnLatencyMs: number;
  averageTimeToFirstAudioMs: number;
  p95TimeToFirstAudioMs: number;
  maxTimeToFirstAudioMs: number;
  averageBargeInLatencyMs: number;
  maxBargeInLatencyMs: number;
};

type CompletionPlan = {
  speechMs: number;
  sttFinalDelayMs: number;
  llmTokenDelayMs: number;
  llmSentenceDelayMs: number;
  ttsFirstAudioDelayMs: number;
  ttsCompleteDelayMs: number;
};

type BargeInPlan = {
  speechMs: number;
  sttFinalDelayMs: number;
  llmSentenceDelayMs: number;
  ttsFirstAudioDelayMs: number;
  recoveryTtsDelayMs: number;
};

type FalseStartPlan = {
  llmSentenceDelayMs: number;
  ttsFirstAudioDelayMs: number;
  noiseDurationMs: number;
  ttsCompleteDelayMs: number;
};

type BackchannelPlan = {
  llmSentenceDelayMs: number;
  ttsFirstAudioDelayMs: number;
  speechMs: number;
  sttFinalDelayMs: number;
  ttsCompleteDelayMs: number;
};

type HumanSimulationPlan = {
  completion: CompletionPlan;
  bargeIn: BargeInPlan;
  falseStart: FalseStartPlan;
  backchannel: BackchannelPlan;
};

type MutableHumanSimulationScore = Omit<
  HumanSimulationScore,
  | "averageEndOfTurnLatencyMs"
  | "averageSpeculativeCutoffLatencyMs"
  | "maxSpeculativeCutoffLatencyMs"
  | "p95EndOfTurnLatencyMs"
  | "maxEndOfTurnLatencyMs"
  | "averageTimeToFirstAudioMs"
  | "p95TimeToFirstAudioMs"
  | "maxTimeToFirstAudioMs"
  | "averageBargeInLatencyMs"
  | "maxBargeInLatencyMs"
> & {
  endOfTurnLatencies: number[];
  timeToFirstAudio: number[];
  bargeInLatencies: number[];
  speculativeCutoffLatencies: number[];
};

export const DEFAULT_HUMAN_SIMULATION_THRESHOLDS: HumanSimulationThresholds = {
  maxFalseInterruptions: 0,
  maxMissedInterruptions: 0,
  maxStaleAudioAfterInterruption: 0,
  maxUnexpectedAIStarts: 0,
  maxSpeculativeCutoffLatencyMs: 20,
  maxBargeInLatencyMs: 220,
  maxP95EndOfTurnLatencyMs: 350,
  maxP95TimeToFirstAudioMs: 430,
};

export function humanSimulationPlanArbitrary(
  interruptionMinDurationMs = 200,
): fc.Arbitrary<HumanSimulationPlan> {
  const minBargeInSpeechMs = interruptionMinDurationMs + 250;

  return fc.record({
    completion: fc.record({
      speechMs: fc.integer({ min: 450, max: 2200 }),
      sttFinalDelayMs: fc.integer({ min: 80, max: 330 }),
      llmTokenDelayMs: fc.integer({ min: 35, max: 120 }),
      llmSentenceDelayMs: fc.integer({ min: 35, max: 90 }),
      ttsFirstAudioDelayMs: fc.integer({ min: 45, max: 170 }),
      ttsCompleteDelayMs: fc.integer({ min: 120, max: 900 }),
    }),
    bargeIn: fc.record({
      speechMs: fc.integer({
        min: minBargeInSpeechMs,
        max: Math.max(minBargeInSpeechMs, 1900),
      }),
      sttFinalDelayMs: fc.integer({ min: 80, max: 260 }),
      llmSentenceDelayMs: fc.integer({ min: 30, max: 90 }),
      ttsFirstAudioDelayMs: fc.integer({ min: 40, max: 140 }),
      recoveryTtsDelayMs: fc.integer({ min: 45, max: 150 }),
    }),
    falseStart: fc.record({
      llmSentenceDelayMs: fc.integer({ min: 30, max: 90 }),
      ttsFirstAudioDelayMs: fc.integer({ min: 40, max: 140 }),
      noiseDurationMs: fc.integer({
        min: 25,
        max: Math.max(25, interruptionMinDurationMs - 30),
      }),
      ttsCompleteDelayMs: fc.integer({ min: 100, max: 600 }),
    }),
    backchannel: fc.record({
      llmSentenceDelayMs: fc.integer({ min: 30, max: 90 }),
      ttsFirstAudioDelayMs: fc.integer({ min: 40, max: 140 }),
      speechMs: fc.integer({ min: 45, max: Math.max(45, interruptionMinDurationMs - 40) }),
      sttFinalDelayMs: fc.integer({ min: 20, max: 120 }),
      ttsCompleteDelayMs: fc.integer({ min: 100, max: 600 }),
    }),
  });
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted: number[] = [];
  for (const value of values) {
    const index = sorted.findIndex((candidate) => candidate > value);
    if (index === -1) {
      sorted.push(value);
    } else {
      sorted.splice(index, 0, value);
    }
  }
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function createHumanHarness(interruptionMinDurationMs: number): AgentHarness {
  return createAgentHarness({
    useVAD: true,
    interruption: { enabled: true, minDurationMs: interruptionMinDurationMs },
  });
}

async function recordSpeculativeCutoff(
  harness: AgentHarness,
  score: MutableHumanSimulationScore,
  speechStartedAt: number,
): Promise<void> {
  const pending = await harness.events.waitForRecordedEvent("ai-turn:interruption-pending", {
    timeoutMs: 20,
  });
  score.speculativeCutoffs++;
  score.speculativeCutoffLatencies.push(pending.receivedAt - speechStartedAt);
}

async function recordCancelledSpeculativeCutoff(harness: AgentHarness): Promise<boolean> {
  const cancelled = await harness.events
    .waitForRecordedEvent("ai-turn:interruption-cancelled", { timeoutMs: 20 })
    .catch(() => null);
  return cancelled !== null;
}

async function runCompletedTurn(
  plan: CompletionPlan,
  score: MutableHumanSimulationScore,
  interruptionMinDurationMs: number,
): Promise<void> {
  const harness = createHumanHarness(interruptionMinDurationMs);
  const { agent, events, vad, stt, llm, tts, advance, clock } = harness;

  agent.start();
  await events.waitForEvent("agent:started");

  vad?.emitSpeechStart();
  advance(plan.speechMs);
  const speechEndedAt = clock.now();
  vad?.emitSpeechEnd(plan.speechMs);
  advance(plan.sttFinalDelayMs);
  stt.emitTranscript("I need help changing my appointment", true);

  const humanEnded = await events.waitForRecordedEvent("human-turn:ended");
  score.endOfTurnLatencies.push(humanEnded.receivedAt - speechEndedAt);
  await events.waitForEvent("ai-turn:started");

  advance(plan.llmTokenDelayMs);
  llm.emitToken("Sure");
  advance(plan.llmSentenceDelayMs);
  llm.emitSentence("Sure, I can help with that.", 0);
  advance(plan.ttsFirstAudioDelayMs);
  tts.emitAudio(makeAudioChunk(1, 4));
  advance(plan.ttsCompleteDelayMs);
  llm.complete("Sure, I can help with that.");
  tts.complete();

  const aiEnded = await events.waitForEvent("ai-turn:ended");
  score.timeToFirstAudio.push(
    aiEnded.metrics.timeToFirstToken +
      aiEnded.metrics.timeToFirstSentence +
      aiEnded.metrics.timeToFirstAudio,
  );
  score.completedTurns++;
  agent.stop();
}

async function runBargeInTurn(
  plan: BargeInPlan,
  score: MutableHumanSimulationScore,
  interruptionMinDurationMs: number,
): Promise<void> {
  const harness = createHumanHarness(interruptionMinDurationMs);
  const { agent, events, vad, stt, llm, tts, advance, clock } = harness;

  agent.start();
  await events.waitForEvent("agent:started");
  stt.emitTranscript("Tell me about the refund policy", true);
  await events.waitForEvent("ai-turn:started");

  advance(plan.llmSentenceDelayMs);
  llm.emitSentence("The refund policy depends on the booking type.", 0);
  advance(plan.ttsFirstAudioDelayMs);
  tts.emitAudio(makeAudioChunk(2, 4));

  const interruptedRequest = tts.getCurrentRequest();
  const bargeInStartedAt = clock.now();
  vad?.emitSpeechStart();
  await recordSpeculativeCutoff(harness, score, bargeInStartedAt);
  advance(interruptionMinDurationMs);

  const interrupted = await events
    .waitForRecordedEvent("ai-turn:interrupted", { timeoutMs: 20 })
    .catch(() => null);

  if (!interrupted) {
    score.missedInterruptions++;
    agent.stop();
    return;
  }

  score.interruptedTurns++;
  score.bargeInLatencies.push(interrupted.receivedAt - bargeInStartedAt);

  const audioEventsBeforeStale = events.byType("ai-turn:audio").length;
  interruptedRequest?.ctx.audioChunk(makeAudioChunk(9, 4));
  await drainMicrotasks();
  const staleAudio = events.byType("ai-turn:audio").length - audioEventsBeforeStale;
  score.staleAudioAfterInterruption += Math.max(0, staleAudio);

  advance(plan.speechMs - interruptionMinDurationMs);
  vad?.emitSpeechEnd(plan.speechMs);
  advance(plan.sttFinalDelayMs);
  stt.emitTranscript("Actually, I need to cancel it", true);
  await events.waitForEvent("human-turn:ended");
  await events.waitForEvent("ai-turn:started", { fromIndex: interrupted.index + 1 });

  llm.emitSentence("Got it, I can help you cancel it.", 0);
  advance(plan.recoveryTtsDelayMs);
  tts.emitAudio(makeAudioChunk(3, 4));
  llm.complete("Got it, I can help you cancel it.");
  tts.complete();
  await events.waitForEvent("ai-turn:ended");
  agent.stop();
}

async function runFalseStartTurn(
  plan: FalseStartPlan,
  score: MutableHumanSimulationScore,
  interruptionMinDurationMs: number,
): Promise<void> {
  const harness = createHumanHarness(interruptionMinDurationMs);
  const { agent, events, vad, stt, llm, tts, advance } = harness;

  agent.start();
  await events.waitForEvent("agent:started");
  stt.emitTranscript("Can you summarize this?", true);
  await events.waitForEvent("ai-turn:started");

  advance(plan.llmSentenceDelayMs);
  llm.emitSentence("Here is the short version.", 0);
  advance(plan.ttsFirstAudioDelayMs);
  tts.emitAudio(makeAudioChunk(4, 4));

  const noiseStartedAt = harness.clock.now();
  vad?.emitSpeechStart();
  await recordSpeculativeCutoff(harness, score, noiseStartedAt);
  advance(plan.noiseDurationMs);
  vad?.emitSpeechEnd(plan.noiseDurationMs);
  await drainMicrotasks();

  if (await recordCancelledSpeculativeCutoff(harness)) {
    score.cancelledSpeculativeCutoffs++;
  }
  score.falseInterruptions += events.byType("ai-turn:interrupted").length;

  advance(plan.ttsCompleteDelayMs);
  llm.complete("Here is the short version.");
  tts.complete();
  await events.waitForEvent("ai-turn:ended");
  score.completedTurns++;
  agent.stop();
}

async function runBackchannelTurn(
  plan: BackchannelPlan,
  score: MutableHumanSimulationScore,
  interruptionMinDurationMs: number,
): Promise<void> {
  const harness = createHumanHarness(interruptionMinDurationMs);
  const { agent, events, vad, stt, llm, tts, advance } = harness;

  agent.start();
  await events.waitForEvent("agent:started");
  stt.emitTranscript("Please explain the plan", true);
  await events.waitForEvent("ai-turn:started");

  advance(plan.llmSentenceDelayMs);
  llm.emitSentence("The plan has three important steps.", 0);
  advance(plan.ttsFirstAudioDelayMs);
  tts.emitAudio(makeAudioChunk(5, 4));

  const aiStartsBeforeBackchannel = events.byType("ai-turn:started").length;
  const backchannelStartedAt = harness.clock.now();
  vad?.emitSpeechStart();
  await recordSpeculativeCutoff(harness, score, backchannelStartedAt);
  advance(plan.speechMs);
  vad?.emitSpeechEnd(plan.speechMs);
  if (await recordCancelledSpeculativeCutoff(harness)) {
    score.cancelledSpeculativeCutoffs++;
  }
  advance(plan.sttFinalDelayMs);
  stt.emitTranscript("yeah", true);
  await drainMicrotasks();
  advance(interruptionMinDurationMs);
  await drainMicrotasks();

  score.falseInterruptions += events.byType("ai-turn:interrupted").length;
  score.unexpectedAIStarts += Math.max(
    0,
    events.byType("ai-turn:started").length - aiStartsBeforeBackchannel,
  );
  score.backchannelTurns++;

  advance(plan.ttsCompleteDelayMs);
  llm.complete("The plan has three important steps.");
  tts.complete();
  await events.waitForEvent("ai-turn:ended");
  score.completedTurns++;
  agent.stop();
}

function createInitialScore(seed: number, runs: number): MutableHumanSimulationScore {
  return {
    seed,
    runs,
    completedTurns: 0,
    interruptedTurns: 0,
    backchannelTurns: 0,
    speculativeCutoffs: 0,
    cancelledSpeculativeCutoffs: 0,
    falseInterruptions: 0,
    missedInterruptions: 0,
    staleAudioAfterInterruption: 0,
    unexpectedAIStarts: 0,
    endOfTurnLatencies: [],
    timeToFirstAudio: [],
    bargeInLatencies: [],
    speculativeCutoffLatencies: [],
  };
}

function finalizeScore(score: MutableHumanSimulationScore): HumanSimulationScore {
  return {
    seed: score.seed,
    runs: score.runs,
    completedTurns: score.completedTurns,
    interruptedTurns: score.interruptedTurns,
    backchannelTurns: score.backchannelTurns,
    speculativeCutoffs: score.speculativeCutoffs,
    cancelledSpeculativeCutoffs: score.cancelledSpeculativeCutoffs,
    falseInterruptions: score.falseInterruptions,
    missedInterruptions: score.missedInterruptions,
    staleAudioAfterInterruption: score.staleAudioAfterInterruption,
    unexpectedAIStarts: score.unexpectedAIStarts,
    averageSpeculativeCutoffLatencyMs: average(score.speculativeCutoffLatencies),
    maxSpeculativeCutoffLatencyMs: max(score.speculativeCutoffLatencies),
    averageEndOfTurnLatencyMs: average(score.endOfTurnLatencies),
    p95EndOfTurnLatencyMs: percentile(score.endOfTurnLatencies, 95),
    maxEndOfTurnLatencyMs: max(score.endOfTurnLatencies),
    averageTimeToFirstAudioMs: average(score.timeToFirstAudio),
    p95TimeToFirstAudioMs: percentile(score.timeToFirstAudio, 95),
    maxTimeToFirstAudioMs: max(score.timeToFirstAudio),
    averageBargeInLatencyMs: average(score.bargeInLatencies),
    maxBargeInLatencyMs: max(score.bargeInLatencies),
  };
}

export async function runHumanSimulation(
  options: HumanSimulationOptions = {},
): Promise<HumanSimulationScore> {
  const seed = options.seed ?? Date.now();
  const runs = options.runs ?? 100;
  const interruptionMinDurationMs = options.interruptionMinDurationMs ?? 200;
  const plans = fc.sample(humanSimulationPlanArbitrary(interruptionMinDurationMs), {
    numRuns: runs,
    seed,
  });
  const score = createInitialScore(seed, runs);

  for (const [index, plan] of plans.entries()) {
    let phase = "completed turn";
    try {
      phase = "completed turn";
      await runCompletedTurn(plan.completion, score, interruptionMinDurationMs);
      phase = "barge-in turn";
      await runBargeInTurn(plan.bargeIn, score, interruptionMinDurationMs);
      phase = "false-start turn";
      await runFalseStartTurn(plan.falseStart, score, interruptionMinDurationMs);
      phase = "backchannel turn";
      await runBackchannelTurn(plan.backchannel, score, interruptionMinDurationMs);
    } catch (error) {
      throw new Error(
        [
          `Human simulation failed for seed ${seed}, run ${index}, phase ${phase}`,
          JSON.stringify(plan, null, 2),
          error instanceof Error ? error.message : String(error),
        ].join("\n"),
        { cause: error },
      );
    }
  }

  return finalizeScore(score);
}

export function assertHumanSimulationPass(
  score: HumanSimulationScore,
  thresholds: HumanSimulationThresholds = DEFAULT_HUMAN_SIMULATION_THRESHOLDS,
): void {
  const failures: string[] = [];

  if (score.falseInterruptions > thresholds.maxFalseInterruptions) {
    failures.push(`false interruptions: ${score.falseInterruptions}`);
  }
  if (score.missedInterruptions > thresholds.maxMissedInterruptions) {
    failures.push(`missed interruptions: ${score.missedInterruptions}`);
  }
  if (score.staleAudioAfterInterruption > thresholds.maxStaleAudioAfterInterruption) {
    failures.push(`stale audio after interruption: ${score.staleAudioAfterInterruption}`);
  }
  if (score.unexpectedAIStarts > thresholds.maxUnexpectedAIStarts) {
    failures.push(`unexpected AI starts: ${score.unexpectedAIStarts}`);
  }
  if (score.maxSpeculativeCutoffLatencyMs > thresholds.maxSpeculativeCutoffLatencyMs) {
    failures.push(`max speculative cutoff latency: ${score.maxSpeculativeCutoffLatencyMs}ms`);
  }
  if (score.maxBargeInLatencyMs > thresholds.maxBargeInLatencyMs) {
    failures.push(`max barge-in latency: ${score.maxBargeInLatencyMs}ms`);
  }
  if (score.p95EndOfTurnLatencyMs > thresholds.maxP95EndOfTurnLatencyMs) {
    failures.push(`p95 end-of-turn latency: ${score.p95EndOfTurnLatencyMs}ms`);
  }
  if (score.p95TimeToFirstAudioMs > thresholds.maxP95TimeToFirstAudioMs) {
    failures.push(`p95 time-to-first-audio: ${score.p95TimeToFirstAudioMs}ms`);
  }

  if (failures.length > 0) {
    throw new Error([`Human simulation failed for seed ${score.seed}`, ...failures].join("\n"));
  }
}
