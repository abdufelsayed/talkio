/**
 * End-of-turn timing for turn detectors that report probabilities.
 *
 * @module agent/turn-taking
 */

import type { ResolvedTurnTakingConfig, TurnTakingConfig } from "../types/config";

const EAGERNESS_PRESETS: Record<
  NonNullable<TurnTakingConfig["eagerness"]>,
  { minEndOfTurnDelayMs: number; maxEndOfTurnDelayMs: number }
> = {
  high: { minEndOfTurnDelayMs: 200, maxEndOfTurnDelayMs: 1200 },
  medium: { minEndOfTurnDelayMs: 400, maxEndOfTurnDelayMs: 2500 },
  low: { minEndOfTurnDelayMs: 800, maxEndOfTurnDelayMs: 5000 },
};

const DEFAULT_END_OF_TURN_THRESHOLD = 0.7;
const DEFAULT_EAGER_END_OF_TURN_THRESHOLD = 0.5;

export function resolveTurnTakingConfig(
  config: TurnTakingConfig | undefined,
): ResolvedTurnTakingConfig {
  const preset = EAGERNESS_PRESETS[config?.eagerness ?? "medium"];
  const minEndOfTurnDelayMs = Math.max(
    0,
    config?.minEndOfTurnDelayMs ?? preset.minEndOfTurnDelayMs,
  );
  const maxEndOfTurnDelayMs = Math.max(
    minEndOfTurnDelayMs,
    config?.maxEndOfTurnDelayMs ?? preset.maxEndOfTurnDelayMs,
  );
  const endOfTurnThreshold = Math.min(
    1,
    Math.max(Number.EPSILON, config?.endOfTurnThreshold ?? DEFAULT_END_OF_TURN_THRESHOLD),
  );
  const eagerEndOfTurnThreshold = Math.min(
    endOfTurnThreshold,
    Math.max(0, config?.eagerEndOfTurnThreshold ?? DEFAULT_EAGER_END_OF_TURN_THRESHOLD),
  );
  return {
    minEndOfTurnDelayMs,
    maxEndOfTurnDelayMs,
    endOfTurnThreshold,
    preemptiveGeneration: config?.preemptiveGeneration ?? true,
    eagerEndOfTurnThreshold,
  };
}

/**
 * Silence to wait before ending the user's turn. Confident predictions wait
 * the minimum; without a prediction the agent waits the maximum, so a slow
 * detector delays the reply instead of cutting the user off.
 */
export function endOfTurnDelayMs(
  probability: number | null,
  config: ResolvedTurnTakingConfig,
): number {
  if (probability === null) return config.maxEndOfTurnDelayMs;
  const confidence = Math.min(1, Math.max(0, probability) / config.endOfTurnThreshold);
  return (
    config.maxEndOfTurnDelayMs -
    (config.maxEndOfTurnDelayMs - config.minEndOfTurnDelayMs) * confidence
  );
}
