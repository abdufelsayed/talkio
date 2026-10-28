import * as fc from "fast-check";

import {
  aiTurnLifecycleTraceArbitrary,
  assertHumanSimulationPass,
  assertTraceInvariants,
  assertTraceLatencyBudgets,
  generateScenarioTrace,
  runHumanSimulation,
  runTrace,
} from "../src";

type StressOptions = {
  runs: number;
  seed: number;
  turns: number;
  humanRuns: number;
  lifecycleRuns: number;
};

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options: StressOptions = {
    runs: readNumberFlag(args, "--runs", 100),
    seed: readNumberFlag(args, "--seed", Date.now()),
    turns: readNumberFlag(args, "--turns", 4),
    humanRuns: readNumberFlag(args, "--human-runs", 100),
    lifecycleRuns: readNumberFlag(args, "--lifecycle-runs", 100),
  };

  for (let index = 0; index < options.runs; index++) {
    const generated = generateScenarioTrace({
      seed: options.seed + index,
      turns: options.turns,
    });

    try {
      const result = await runTrace(generated.trace);
      assertTraceInvariants(result.traces);
    } catch (error) {
      console.error(`Stress failure for seed ${generated.seed}`);
      console.error(
        `Replay with: bun run --cwd packages/testkit test:stress -- --runs 1 --seed ${generated.seed} --turns ${options.turns}`,
      );
      console.error(JSON.stringify(generated.trace, null, 2));
      throw error;
    }
  }

  console.log(
    `Stress run passed: ${options.runs} runs from seed ${options.seed} with ${options.turns} turns`,
  );

  for (let index = 0; index < options.lifecycleRuns; index++) {
    const seed = options.seed + index;
    const [trace] = fc.sample(aiTurnLifecycleTraceArbitrary({ turns: options.turns }), {
      numRuns: 1,
      seed,
    });
    if (!trace) {
      throw new Error(`Failed to sample lifecycle trace for seed ${seed}`);
    }

    try {
      const result = await runTrace(trace);
      assertTraceInvariants(result.traces);
      assertTraceLatencyBudgets(result.traces);
    } catch (error) {
      console.error(`Lifecycle stress failure for seed ${seed}`);
      console.error(
        `Replay with: bun run --cwd packages/testkit test:stress -- --runs 0 --lifecycle-runs 1 --seed ${seed} --turns ${options.turns}`,
      );
      console.error(JSON.stringify(trace, null, 2));
      throw error;
    }
  }

  console.log(
    `Lifecycle stress passed: ${options.lifecycleRuns} runs from seed ${options.seed} with ${options.turns} turns`,
  );

  const humanScore = await runHumanSimulation({
    runs: options.humanRuns,
    seed: options.seed,
  });
  assertHumanSimulationPass(humanScore);
  console.log(
    [
      `Human simulation passed: ${humanScore.runs} runs from seed ${humanScore.seed}`,
      `p95 EOT=${humanScore.p95EndOfTurnLatencyMs}ms`,
      `p95 TFA=${humanScore.p95TimeToFirstAudioMs}ms`,
      `max cutoff=${humanScore.maxSpeculativeCutoffLatencyMs}ms`,
      `max barge-in=${humanScore.maxBargeInLatencyMs}ms`,
      `backchannels=${humanScore.backchannelTurns}`,
    ].join(", "),
  );
}

await main();
