import type { AgentConfig, NormalizedAgentConfig } from "../types/config";

type TimedConfig =
  | Pick<AgentConfig, "simulatedClock">
  | Pick<NormalizedAgentConfig, "simulatedClock">;
export type TimeoutHandle = ReturnType<typeof setTimeout> | number;

export function getConfigNow(config: TimedConfig): number {
  return config.simulatedClock?.now() ?? Date.now();
}

export function setConfigTimeout(
  config: TimedConfig,
  callback: () => void,
  timeoutMs: number,
): TimeoutHandle {
  return config.simulatedClock?.setTimeout(callback, timeoutMs) ?? setTimeout(callback, timeoutMs);
}

export function clearConfigTimeout(config: TimedConfig, handle: TimeoutHandle): void {
  if (config.simulatedClock) {
    config.simulatedClock.clearTimeout(handle as number);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
