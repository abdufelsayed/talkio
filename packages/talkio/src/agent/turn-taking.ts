/**
 * End-of-turn timing for turn detectors that report probabilities.
 *
 * @module agent/turn-taking
 */

import type { ResolvedTurnTakingConfig, TurnTakingConfig } from "../types/config";

const EAGERNESS_PRESETS: Record<
  NonNullable<TurnTakingConfig["eagerness"]>,
  { minDelayMs: number; maxDelayMs: number }
> = {
  high: { minDelayMs: 200, maxDelayMs: 1200 },
  medium: { minDelayMs: 400, maxDelayMs: 2500 },
  low: { minDelayMs: 800, maxDelayMs: 5000 },
};

const DEFAULT_END_OF_TURN_THRESHOLD = 0.7;
const DEFAULT_EAGER_END_OF_TURN_THRESHOLD = 0.5;

export function resolveTurnTakingConfig(
  config: TurnTakingConfig | undefined,
): ResolvedTurnTakingConfig {
  const preset = EAGERNESS_PRESETS[config?.eagerness ?? "medium"];
  const minDelayMs = Math.max(0, config?.minDelayMs ?? preset.minDelayMs);
  const maxDelayMs = Math.max(minDelayMs, config?.maxDelayMs ?? preset.maxDelayMs);
  const threshold = Math.min(
    1,
    Math.max(Number.EPSILON, config?.threshold ?? DEFAULT_END_OF_TURN_THRESHOLD),
  );
  const eagerThreshold = Math.min(
    threshold,
    Math.max(0, config?.eagerThreshold ?? DEFAULT_EAGER_END_OF_TURN_THRESHOLD),
  );
  return {
    minDelayMs,
    maxDelayMs,
    threshold,
    preemptiveGeneration: config?.preemptiveGeneration ?? true,
    eagerThreshold,
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
  if (probability === null) return config.maxDelayMs;
  const confidence = Math.min(1, Math.max(0, probability) / config.threshold);
  return config.maxDelayMs - (config.maxDelayMs - config.minDelayMs) * confidence;
}
