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
    assertValueMatch(actual[key], expectedValue, `${label}.${key}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Objects match partially, arrays element by element, anything else by identity. */
function assertValueMatch(actual: unknown, expected: unknown, label: string): void {
  if (isPlainObject(expected) && isPlainObject(actual)) {
    assertPartialMatch(actual, expected, label);
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual) && actual.length === expected.length) {
    expected.forEach((value, index) =>
      assertValueMatch(actual[index], value, `${label}[${index}]`),
    );
    return;
  }
  if (!Object.is(actual, expected)) {
    throw new ScenarioAssertionError(
      `${label} expected ${stringify(expected)} but received ${stringify(actual)}`,
    );
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
  const startedCount = types.filter((type) => type === "agent:started").length;
  const stoppedCount = types.filter((type) => type === "agent:stopped").length;

  if (startedCount > 1) {
    throw new ScenarioAssertionError("agent:started must be emitted at most once");
  }

  if (stoppedCount > 1) {
    throw new ScenarioAssertionError("agent:stopped must be emitted at most once");
  }

  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let previousReceivedAt = Number.NEGATIVE_INFINITY;
  for (const [index, entry] of events.entries()) {
    if (!Number.isFinite(entry.event.timestamp)) {
      throw new ScenarioAssertionError(`Event ${index} has an invalid timestamp`);
    }
    if (entry.event.timestamp < previousTimestamp) {
      throw new ScenarioAssertionError(`Event ${index} timestamp moved backwards`);
    }
    if (entry.receivedAt < previousReceivedAt) {
      throw new ScenarioAssertionError(`Event ${index} receivedAt moved backwards`);
    }
    previousTimestamp = entry.event.timestamp;
    previousReceivedAt = entry.receivedAt;
  }

  if (startedIndex >= 0) {
    const turnEventIndex = types.findIndex(
      (type) => type.startsWith("user-turn") || type.startsWith("agent-turn"),
    );
    if (turnEventIndex >= 0 && startedIndex > turnEventIndex) {
      throw new ScenarioAssertionError("agent:started must occur before turn events");
    }
  }

  const aiTurnStarts = types
    .map((type, index) => ({ type, index }))
    .filter((entry) => entry.type === "agent-turn:started")
    .map((entry) => entry.index);
  const aiTurnBoundaries = types
    .map((type, index) => ({ type, index }))
    .filter(
      (entry) =>
        entry.type === "agent-turn:ended" ||
        entry.type === "agent-turn:interrupted" ||
        entry.type === "agent:error" ||
        entry.type === "agent:stopped",
    )
    .map((entry) => entry.index);

  for (const startIndex of aiTurnStarts) {
    const hasBoundary = aiTurnBoundaries.some((endIndex) => endIndex > startIndex);
    if (!hasBoundary) {
      throw new ScenarioAssertionError("Every agent-turn:started must have a later boundary event");
    }
  }

  if (stoppedIndex >= 0 && stoppedIndex !== types.length - 1) {
    throw new ScenarioAssertionError("agent:stopped must be the final public event");
  }

  let humanTurnOpen = false;
  // Audio of an interrupted turn is stale until the next AI turn starts; other audio,
  // such as a backchannel, may still play.
  let interruptedTurn: { turnId: string | undefined } | null = null;
  let aiTurnOpen = false;

  for (const [index, entry] of events.entries()) {
    const type = entry.event.type;
    if (type === "user-turn:started") {
      if (humanTurnOpen) {
        throw new ScenarioAssertionError("user-turn:started emitted before previous turn closed");
      }
      humanTurnOpen = true;
    } else if (type === "user-turn:ended" || type === "user-turn:abandoned") {
      if (!humanTurnOpen) {
        throw new ScenarioAssertionError(`${type} emitted without user-turn:started`);
      }
      humanTurnOpen = false;
    }

    if (type === "agent-turn:started") {
      if (aiTurnOpen) {
        throw new ScenarioAssertionError("agent-turn:started emitted before previous turn closed");
      }
      if (humanTurnOpen) {
        throw new ScenarioAssertionError("agent-turn:started emitted while a human turn was open");
      }
      aiTurnOpen = true;
      interruptedTurn = null;
    } else if (type === "agent-turn:ended" || type === "agent-turn:interrupted") {
      if (!aiTurnOpen) {
        throw new ScenarioAssertionError(`${type} emitted without agent-turn:started`);
      }
      aiTurnOpen = false;
      if (type === "agent-turn:interrupted") {
        interruptedTurn = { turnId: entry.event.turnId };
      }
    } else if (
      type === "agent:stopped" ||
      (type === "agent:error" && entry.event.source === "llm")
    ) {
      aiTurnOpen = false;
    } else if (
      type === "agent-turn:audio" &&
      interruptedTurn !== null &&
      entry.event.turnId === interruptedTurn.turnId
    ) {
      throw new ScenarioAssertionError(
        `Stale agent-turn:audio emitted after interruption at ${index}`,
      );
    }
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
