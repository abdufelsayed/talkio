import * as fc from "fast-check";
import type { InterruptionCancelReason } from "talkio";

import { makeAudioChunk } from "./audio";
import { drainMicrotasks } from "./clock";
import { createAgentHarness, type AgentHarness } from "./harness";
import { assertTraceInvariants } from "./trace-assertions";

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
  /** Overlaps cancelled for the wrong reason, such as a backchannel treated as noise. */
  maxMisclassifiedOverlaps: number;
  maxSpeculativeCutoffLatencyMs: number;
  /** From the start of a barge-in to the confirmed interruption; bounded by STT latency. */
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
  noiseTurns: number;
  echoTurns: number;
  speculativeCutoffs: number;
  cancelledSpeculativeCutoffs: number;
  falseInterruptions: number;
  missedInterruptions: number;
  staleAudioAfterInterruption: number;
  unexpectedAIStarts: number;
  misclassifiedOverlaps: number;
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

type ResponsePlan = {
  llmSentenceDelayMs: number;
  ttsFirstAudioDelayMs: number;
  ttsCompleteDelayMs: number;
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
  interimDelayMs: number;
  sttFinalDelayMs: number;
  llmSentenceDelayMs: number;
  ttsFirstAudioDelayMs: number;
  recoveryTtsDelayMs: number;
};

type FalseStartPlan = ResponsePlan & { noiseDurationMs: number };

type BackchannelPlan = ResponsePlan & {
  phrase: string;
  speechMs: number;
  interimFraction: number;
  sttFinalDelayMs: number;
};

type NoisePlan = ResponsePlan & { noiseDurationMs: number };

type EchoPlan = ResponsePlan & { speechMs: number; interimFraction: number };

type HumanSimulationPlan = {
  completion: CompletionPlan;
  bargeIn: BargeInPlan;
  falseStart: FalseStartPlan;
  backchannel: BackchannelPlan;
  noise: NoisePlan;
  echo: EchoPlan;
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
  maxMisclassifiedOverlaps: 0,
  maxSpeculativeCutoffLatencyMs: 20,
  maxBargeInLatencyMs: 450,
  maxP95EndOfTurnLatencyMs: 350,
  maxP95TimeToFirstAudioMs: 430,
};

/** How long the agent waits for words after wordless speech before resuming. */
const RESUME_AFTER_MS = 600;

const AGENT_SENTENCE = "The plan has three important steps.";

const responsePlan = {
  llmSentenceDelayMs: fc.integer({ min: 30, max: 90 }),
  ttsFirstAudioDelayMs: fc.integer({ min: 40, max: 140 }),
  ttsCompleteDelayMs: fc.integer({ min: 100, max: 600 }),
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
      interimDelayMs: fc.integer({ min: 150, max: 400 }),
      sttFinalDelayMs: fc.integer({ min: 80, max: 260 }),
      llmSentenceDelayMs: fc.integer({ min: 30, max: 90 }),
      ttsFirstAudioDelayMs: fc.integer({ min: 40, max: 140 }),
      recoveryTtsDelayMs: fc.integer({ min: 45, max: 150 }),
    }),
    falseStart: fc.record({
      ...responsePlan,
      noiseDurationMs: fc.integer({ min: 25, max: Math.max(25, interruptionMinDurationMs - 30) }),
    }),
    backchannel: fc.record({
      ...responsePlan,
      phrase: fc.constantFrom("mm-hmm", "yeah", "right", "okay", "uh-huh", "yeah yeah", "got it"),
      speechMs: fc.integer({ min: 250, max: 700 }),
      interimFraction: fc.double({ min: 0.4, max: 0.9, noNaN: true }),
      sttFinalDelayMs: fc.integer({ min: 20, max: 300 }),
    }),
    noise: fc.record({
      ...responsePlan,
      noiseDurationMs: fc.integer({ min: interruptionMinDurationMs + 50, max: 900 }),
    }),
    echo: fc.record({
      ...responsePlan,
      speechMs: fc.integer({ min: 300, max: 800 }),
      interimFraction: fc.double({ min: 0.4, max: 0.9, noNaN: true }),
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
    interruption: {
      minDurationMs: interruptionMinDurationMs,
      resumeAfterMs: RESUME_AFTER_MS,
    },
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

/** Counts the cancellation and whether it happened for the expected reason. */
async function recordCancellation(
  harness: AgentHarness,
  score: MutableHumanSimulationScore,
  expected: InterruptionCancelReason,
): Promise<void> {
  const cancelled = await harness.events
    .waitForEvent("ai-turn:interruption-cancelled", { timeoutMs: 20 })
    .catch(() => null);
  if (cancelled) score.cancelledSpeculativeCutoffs++;
  if (cancelled?.reason !== expected) score.misclassifiedOverlaps++;
}

/** Starts an agent reply to `userText` that is audibly speaking `sentence`. */
async function startAgentReply(
  harness: AgentHarness,
  plan: Pick<ResponsePlan, "llmSentenceDelayMs" | "ttsFirstAudioDelayMs">,
  userText: string,
  sentence: string,
  chunkValue: number,
): Promise<void> {
  harness.agent.start();
  await harness.events.waitForEvent("agent:started");
  harness.stt.emitTranscript(userText, true);
  await harness.events.waitForEvent("ai-turn:started");
  harness.advance(plan.llmSentenceDelayMs);
  harness.llm.emitSentence(sentence, 0);
  harness.advance(plan.ttsFirstAudioDelayMs);
  harness.tts.emitAudio(makeAudioChunk(chunkValue, 4));
}

/** Lets the reply finish and checks the overlap did not derail it. */
async function finishAgentReply(
  harness: AgentHarness,
  score: MutableHumanSimulationScore,
  plan: Pick<ResponsePlan, "ttsCompleteDelayMs">,
  sentence: string,
): Promise<void> {
  score.falseInterruptions += harness.events.byType("ai-turn:interrupted").length;
  score.unexpectedAIStarts += Math.max(0, harness.events.byType("ai-turn:started").length - 1);
  harness.advance(plan.ttsCompleteDelayMs);
  harness.llm.complete(sentence);
  harness.tts.complete();
  await harness.events.waitForEvent("ai-turn:ended");
  score.completedTurns++;
  harness.agent.stop();
  assertTraceInvariants(harness.traces);
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
  assertTraceInvariants(harness.traces);
}

async function runBargeInTurn(
  plan: BargeInPlan,
  score: MutableHumanSimulationScore,
  interruptionMinDurationMs: number,
): Promise<void> {
  const harness = createHumanHarness(interruptionMinDurationMs);
  const { agent, events, vad, stt, llm, tts, advance, clock } = harness;

  await startAgentReply(
    harness,
    plan,
    "Tell me about the refund policy",
    "The refund policy depends on the booking type.",
    2,
  );

  const interruptedRequest = tts.getCurrentRequest();
  const bargeInStartedAt = clock.now();
  vad?.emitSpeechStart();
  await recordSpeculativeCutoff(harness, score, bargeInStartedAt);
  advance(plan.interimDelayMs);
  stt.emitTranscript("Actually I need", false);

  const interrupted = await events
    .waitForRecordedEvent("ai-turn:interrupted", { timeoutMs: 20 })
    .catch(() => null);

  if (!interrupted) {
    score.missedInterruptions++;
    agent.stop();
    assertTraceInvariants(harness.traces);
    return;
  }

  score.interruptedTurns++;
  score.bargeInLatencies.push(interrupted.receivedAt - bargeInStartedAt);

  const audioEventsBeforeStale = events.byType("ai-turn:audio").length;
  interruptedRequest?.ctx.audio(makeAudioChunk(9, 4));
  await drainMicrotasks();
  const staleAudio = events.byType("ai-turn:audio").length - audioEventsBeforeStale;
  score.staleAudioAfterInterruption += Math.max(0, staleAudio);

  advance(Math.max(0, plan.speechMs - plan.interimDelayMs));
  vad?.emitSpeechEnd(plan.speechMs);
  advance(plan.sttFinalDelayMs);
  stt.emitTranscript("Actually, I need to cancel it", true);
  await events.waitForEvent("human-turn:ended", { fromIndex: interrupted.index + 1 });
  await events.waitForEvent("ai-turn:started", { fromIndex: interrupted.index + 1 });

  llm.emitSentence("Got it, I can help you cancel it.", 0);
  advance(plan.recoveryTtsDelayMs);
  tts.emitAudio(makeAudioChunk(3, 4));
  llm.complete("Got it, I can help you cancel it.");
  tts.complete();
  await events.waitForEvent("ai-turn:ended");
  agent.stop();
  assertTraceInvariants(harness.traces);
}

async function runFalseStartTurn(
  plan: FalseStartPlan,
  score: MutableHumanSimulationScore,
  interruptionMinDurationMs: number,
): Promise<void> {
  const harness = createHumanHarness(interruptionMinDurationMs);
  const sentence = "Here is the short version.";
  await startAgentReply(harness, plan, "Can you summarize this?", sentence, 4);

  const noiseStartedAt = harness.clock.now();
  harness.vad?.emitSpeechStart();
  await recordSpeculativeCutoff(harness, score, noiseStartedAt);
  harness.advance(plan.noiseDurationMs);
  harness.vad?.emitSpeechEnd(plan.noiseDurationMs);
  await recordCancellation(harness, score, "false-start");

  await finishAgentReply(harness, score, plan, sentence);
}

async function runBackchannelTurn(
  plan: BackchannelPlan,
  score: MutableHumanSimulationScore,
  interruptionMinDurationMs: number,
): Promise<void> {
  const harness = createHumanHarness(interruptionMinDurationMs);
  await startAgentReply(harness, plan, "Please explain the plan", AGENT_SENTENCE, 5);

  const interimDelayMs = Math.round(plan.speechMs * plan.interimFraction);
  const backchannelStartedAt = harness.clock.now();
  harness.vad?.emitSpeechStart();
  await recordSpeculativeCutoff(harness, score, backchannelStartedAt);
  harness.advance(interimDelayMs);
  harness.stt.emitTranscript(plan.phrase, false);
  harness.advance(plan.speechMs - interimDelayMs);
  harness.vad?.emitSpeechEnd(plan.speechMs);
  harness.advance(plan.sttFinalDelayMs);
  harness.stt.emitTranscript(plan.phrase, true);
  await drainMicrotasks();
  await recordCancellation(harness, score, "backchannel");
  score.backchannelTurns++;

  await finishAgentReply(harness, score, plan, AGENT_SENTENCE);
}

async function runNoiseTurn(
  plan: NoisePlan,
  score: MutableHumanSimulationScore,
  interruptionMinDurationMs: number,
): Promise<void> {
  const harness = createHumanHarness(interruptionMinDurationMs);
  await startAgentReply(harness, plan, "Please explain the plan", AGENT_SENTENCE, 6);

  const noiseStartedAt = harness.clock.now();
  harness.vad?.emitSpeechStart();
  await recordSpeculativeCutoff(harness, score, noiseStartedAt);
  harness.advance(plan.noiseDurationMs);
  harness.vad?.emitSpeechEnd(plan.noiseDurationMs);
  harness.advance(RESUME_AFTER_MS);
  await recordCancellation(harness, score, "no-transcript");
  score.noiseTurns++;

  await finishAgentReply(harness, score, plan, AGENT_SENTENCE);
}

async function runEchoTurn(
  plan: EchoPlan,
  score: MutableHumanSimulationScore,
  interruptionMinDurationMs: number,
): Promise<void> {
  const harness = createHumanHarness(interruptionMinDurationMs);
  await startAgentReply(harness, plan, "Please explain the plan", AGENT_SENTENCE, 7);

  const interimDelayMs = Math.round(plan.speechMs * plan.interimFraction);
  const echoStartedAt = harness.clock.now();
  harness.vad?.emitSpeechStart();
  await recordSpeculativeCutoff(harness, score, echoStartedAt);
  harness.advance(interimDelayMs);
  harness.stt.emitTranscript("the plan has three", false);
  harness.advance(plan.speechMs - interimDelayMs);
  harness.vad?.emitSpeechEnd(plan.speechMs);
  await recordCancellation(harness, score, "echo");
  score.echoTurns++;

  await finishAgentReply(harness, score, plan, AGENT_SENTENCE);
}

function createInitialScore(seed: number, runs: number): MutableHumanSimulationScore {
  return {
    seed,
    runs,
    completedTurns: 0,
    interruptedTurns: 0,
    backchannelTurns: 0,
    noiseTurns: 0,
    echoTurns: 0,
    speculativeCutoffs: 0,
    cancelledSpeculativeCutoffs: 0,
    falseInterruptions: 0,
    missedInterruptions: 0,
    staleAudioAfterInterruption: 0,
    unexpectedAIStarts: 0,
    misclassifiedOverlaps: 0,
    endOfTurnLatencies: [],
    timeToFirstAudio: [],
    bargeInLatencies: [],
    speculativeCutoffLatencies: [],
  };
}

function finalizeScore(score: MutableHumanSimulationScore): HumanSimulationScore {
  const {
    endOfTurnLatencies,
    timeToFirstAudio,
    bargeInLatencies,
    speculativeCutoffLatencies,
    ...counts
  } = score;
  return {
    ...counts,
    averageSpeculativeCutoffLatencyMs: average(speculativeCutoffLatencies),
    maxSpeculativeCutoffLatencyMs: max(speculativeCutoffLatencies),
    averageEndOfTurnLatencyMs: average(endOfTurnLatencies),
    p95EndOfTurnLatencyMs: percentile(endOfTurnLatencies, 95),
    maxEndOfTurnLatencyMs: max(endOfTurnLatencies),
    averageTimeToFirstAudioMs: average(timeToFirstAudio),
    p95TimeToFirstAudioMs: percentile(timeToFirstAudio, 95),
    maxTimeToFirstAudioMs: max(timeToFirstAudio),
    averageBargeInLatencyMs: average(bargeInLatencies),
    maxBargeInLatencyMs: max(bargeInLatencies),
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

  const phases: Array<[string, (plan: HumanSimulationPlan) => Promise<void>]> = [
    [
      "completed turn",
      (plan) => runCompletedTurn(plan.completion, score, interruptionMinDurationMs),
    ],
    ["barge-in turn", (plan) => runBargeInTurn(plan.bargeIn, score, interruptionMinDurationMs)],
    [
      "false-start turn",
      (plan) => runFalseStartTurn(plan.falseStart, score, interruptionMinDurationMs),
    ],
    [
      "backchannel turn",
      (plan) => runBackchannelTurn(plan.backchannel, score, interruptionMinDurationMs),
    ],
    ["noise turn", (plan) => runNoiseTurn(plan.noise, score, interruptionMinDurationMs)],
    ["echo turn", (plan) => runEchoTurn(plan.echo, score, interruptionMinDurationMs)],
  ];

  for (const [index, plan] of plans.entries()) {
    for (const [phase, run] of phases) {
      try {
        await run(plan);
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
  if (score.misclassifiedOverlaps > thresholds.maxMisclassifiedOverlaps) {
    failures.push(`misclassified overlaps: ${score.misclassifiedOverlaps}`);
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
