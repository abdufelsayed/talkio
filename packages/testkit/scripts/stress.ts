import { generateScenarioTrace, runTrace } from "../src";

type StressOptions = {
  runs: number;
  seed: number;
  turns: number;
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
  };

  for (let index = 0; index < options.runs; index++) {
    const generated = generateScenarioTrace({
      seed: options.seed + index,
      turns: options.turns,
    });

    try {
      await runTrace(generated.trace);
    } catch (error) {
      console.error(`Stress failure for seed ${generated.seed}`);
      console.error(JSON.stringify(generated.trace, null, 2));
      throw error;
    }
  }

  console.log(
    `Stress run passed: ${options.runs} runs from seed ${options.seed} with ${options.turns} turns`,
  );
}

await main();
