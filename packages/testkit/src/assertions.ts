import type { AgentState, PublicAgentEvent } from "talkio";

export type EventType = PublicAgentEvent["type"];

export type RecordedEvent = {
  event: PublicAgentEvent;
  receivedAt: number;
};

export class ScenarioAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioAssertionError";
  }
}

function stringify(value: unknown): string {
  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer(${value.byteLength})`;
  }
  return JSON.stringify(value);
}

export function assertPartialMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];
    if (!Object.is(actualValue, expectedValue)) {
      throw new ScenarioAssertionError(
        `${label}.${key} expected ${stringify(expectedValue)} but received ${stringify(
          actualValue,
        )}`,
      );
    }
  }
}

export function assertEventSequence(events: RecordedEvent[], expected: EventType[]): void {
  const actual = events.map((entry) => entry.event.type);
  if (actual.length !== expected.length) {
    throw new ScenarioAssertionError(
      `Expected ${expected.length} events but received ${actual.length}: ${actual.join(", ")}`,
    );
  }
  expected.forEach((type, index) => {
    if (actual[index] !== type) {
      throw new ScenarioAssertionError(
        `Event ${index} expected ${type} but received ${actual[index] ?? "<none>"}`,
      );
    }
  });
}

export function assertEventInvariants(events: RecordedEvent[]): void {
  const types = events.map((entry) => entry.event.type);
  const startedIndex = types.indexOf("agent:started");
  const stoppedIndex = types.indexOf("agent:stopped");

  if (startedIndex >= 0) {
    const turnEventIndex = types.findIndex(
      (type) => type.startsWith("human-turn") || type.startsWith("ai-turn"),
    );
    if (turnEventIndex >= 0 && startedIndex > turnEventIndex) {
      throw new ScenarioAssertionError("agent:started must occur before turn events");
    }
  }

  const humanTurnEndIndex = types.indexOf("human-turn:ended");
  const aiTurnStartIndex = types.indexOf("ai-turn:started");
  if (humanTurnEndIndex >= 0 && aiTurnStartIndex >= 0 && humanTurnEndIndex > aiTurnStartIndex) {
    throw new ScenarioAssertionError("human-turn:ended must occur before ai-turn:started");
  }

  const aiTurnStarts = types
    .map((type, index) => ({ type, index }))
    .filter((entry) => entry.type === "ai-turn:started")
    .map((entry) => entry.index);
  const aiTurnBoundaries = types
    .map((type, index) => ({ type, index }))
    .filter(
      (entry) =>
        entry.type === "ai-turn:ended" ||
        entry.type === "ai-turn:interrupted" ||
        entry.type === "agent:error" ||
        entry.type === "agent:stopped",
    )
    .map((entry) => entry.index);

  for (const startIndex of aiTurnStarts) {
    const hasBoundary = aiTurnBoundaries.some((endIndex) => endIndex > startIndex);
    if (!hasBoundary) {
      throw new ScenarioAssertionError("Every ai-turn:started must have a later boundary event");
    }
  }

  if (stoppedIndex >= 0 && stoppedIndex !== types.length - 1) {
    throw new ScenarioAssertionError("agent:stopped must be the final public event");
  }

  const internalEvent = types.find((type) => type.startsWith("_"));
  if (internalEvent) {
    throw new ScenarioAssertionError(`Internal event was exposed publicly: ${internalEvent}`);
  }
}

export function assertSnapshotPartial(snapshot: AgentState, expected: Partial<AgentState>): void {
  assertPartialMatch(
    snapshot as unknown as Record<string, unknown>,
    expected as Record<string, unknown>,
    "snapshot",
  );
}
