import type { AgentConfig, NormalizedAgentConfig } from "../types/config";

type TimedConfig = Pick<AgentConfig, "clock"> | Pick<NormalizedAgentConfig, "clock">;
export type TimeoutHandle = ReturnType<typeof setTimeout> | number;

export function getConfigNow(config: TimedConfig): number {
  return config.clock?.now() ?? Date.now();
}

export function setConfigTimeout(
  config: TimedConfig,
  callback: () => void,
  timeoutMs: number,
): TimeoutHandle {
  return config.clock?.setTimeout(callback, timeoutMs) ?? setTimeout(callback, timeoutMs);
}

export function clearConfigTimeout(config: TimedConfig, handle: TimeoutHandle): void {
  if (config.clock) {
    config.clock.clearTimeout(handle as number);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
