import type { NormalizedAgentConfig } from "../types/config";
import type { AgentTraceEvent } from "../types/events";
import { getConfigNow } from "./time";

type TraceInput = Omit<AgentTraceEvent, "timestamp" | "sessionId"> & {
  timestamp?: number;
  sessionId?: string;
};

export function trace(config: NormalizedAgentConfig, event: TraceInput): void {
  const onTrace = config.onTrace;
  if (!onTrace) return;

  const traceEvent: AgentTraceEvent = {
    ...event,
    timestamp: event.timestamp ?? getConfigNow(config),
    sessionId: event.sessionId ?? config.sessionId ?? "unknown",
  };

  try {
    onTrace(traceEvent);
  } catch (error) {
    if (config.debug) {
      console.warn("[trace] onTrace failed:", error);
    }
  }
}
