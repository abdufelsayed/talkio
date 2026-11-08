import { SimulatedClock } from "xstate";

export type TestClock = {
  clock: SimulatedClock;
  advance: (ms: number) => void;
};

export function createTestClock(): TestClock {
  const clock = new SimulatedClock();
  const advance = (ms: number): void => {
    clock.increment(ms);
  };
  return { clock, advance };
}

export async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
}

/** Waits a macrotask, so promise chains such as the thinker's tool runs settle first. */
export async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
