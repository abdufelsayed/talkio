import type { AgentTraceEvent } from "talkio";

import { ScenarioAssertionError } from "./assertions";

export type TraceLatencyBudgets = {
  maxTimeToFirstTokenMs?: number;
  maxTimeToFirstSentenceMs?: number;
  maxTimeToFirstAudioMs?: number;
  maxTimeToFirstAudioFromTurnStartMs?: number;
  maxTimeToAudioSendFromTurnStartMs?: number;
  maxAudioSendLagMs?: number;
  maxTurnDurationMs?: number;
  maxInterruptionPendingMs?: number;
  maxInterruptionConfirmMs?: number;
  maxAudioDrops?: number;
};

export type TraceTurnLatency = {
  turnId: string;
  startedAt: number;
  /** When a speculative turn was confirmed; latency is measured from here. */
  committedAt?: number;
  endedAt?: number;
  interruptedAt?: number;
  firstTokenAt?: number;
  firstSentenceAt?: number;
  firstTTSAudioAt?: number;
  firstAudioSendAt?: number;
  interruptionSpeechStartedAt?: number;
  interruptionPendingAt?: number;
  timeToFirstTokenMs?: number;
  timeToFirstSentenceMs?: number;
  timeToFirstAudioMs?: number;
  timeToFirstAudioFromTurnStartMs?: number;
  timeToAudioSendFromTurnStartMs?: number;
  audioSendLagMs?: number;
  totalDurationMs?: number;
  interruptionPendingLatencyMs?: number;
  interruptionConfirmLatencyMs?: number;
  audioDrops: number;
};

export const DEFAULT_TRACE_LATENCY_BUDGETS: TraceLatencyBudgets = {
  maxTimeToFirstTokenMs: 500,
  maxTimeToFirstSentenceMs: 300,
  maxTimeToFirstAudioMs: 500,
  maxTimeToFirstAudioFromTurnStartMs: 1200,
  maxTimeToAudioSendFromTurnStartMs: 1300,
  maxAudioSendLagMs: 50,
  maxTurnDurationMs: 10_000,
  maxInterruptionPendingMs: 50,
  maxInterruptionConfirmMs: 250,
  maxAudioDrops: 0,
};

type TTSRequestState = {
  turnId: string;
  requestId: string;
  startedAt: number;
  terminalAt?: number;
  terminalType?: string;
  firstAudioSeen: boolean;
};

type TurnTraceState = {
  turnId: string;
  startedAt: number;
  terminalAt?: number;
  terminalType?: "ai-turn:ended" | "ai-turn:interrupted";
  llmStartedAt?: number;
  llmCompletedAt?: number;
  llmFirstTokenSeen: boolean;
  audioDrops: number;
  ttsRequests: Map<string, TTSRequestState>;
};

function fail(message: string): never {
  throw new ScenarioAssertionError(message);
}

function assertTraceTimestamp(event: AgentTraceEvent, index: number): void {
  if (!Number.isFinite(event.timestamp)) {
    fail(`Trace ${index} has an invalid timestamp`);
  }
}

function assertTurnId(event: AgentTraceEvent, index: number): string {
  if (!event.turnId) {
    fail(`Trace ${index} (${event.type}) is missing turnId`);
  }
  return event.turnId;
}

function assertRequestId(event: AgentTraceEvent, index: number): string {
  if (!event.requestId) {
    fail(`Trace ${index} (${event.type}) is missing requestId`);
  }
  return event.requestId;
}

function needsTurnId(type: string): boolean {
  return (
    type.startsWith("llm:") ||
    type.startsWith("tts:") ||
    type === "ai-turn:started" ||
    type === "ai-turn:committed" ||
    type === "ai-turn:discarded" ||
    type === "ai-turn:sentence-queued" ||
    type === "ai-turn:audio" ||
    type === "ai-turn:ended" ||
    type === "ai-turn:interrupted" ||
    type === "interruption:pending" ||
    type === "interruption:cancelled" ||
    type === "audio:send" ||
    type === "audio:drop"
  );
}

function needsRequestId(type: string): boolean {
  return (
    (type.startsWith("tts:") && type !== "tts:queue") ||
    type === "audio:send" ||
    type === "audio:drop"
  );
}

function isOutputAfterTerminal(type: string): boolean {
  return (
    type === "tts:first-audio" ||
    type === "tts:chunk" ||
    type === "ai-turn:audio" ||
    type === "audio:send" ||
    type === "audio:drop"
  );
}

function referencesAITurn(event: AgentTraceEvent): boolean {
  return (
    needsTurnId(event.type) ||
    ((event.type === "speech:start" || event.type === "speech:end") &&
      event.data?.speaking === true)
  );
}

function getTurn(
  turns: Map<string, TurnTraceState>,
  turnId: string,
  event: AgentTraceEvent,
  index: number,
): TurnTraceState {
  const turn = turns.get(turnId);
  if (!turn) {
    fail(`Trace ${index} (${event.type}) references unknown turnId ${turnId}`);
  }
  return turn;
}

function getRequest(
  turn: TurnTraceState,
  requestId: string,
  event: AgentTraceEvent,
  index: number,
): TTSRequestState {
  const request = turn.ttsRequests.get(requestId);
  if (!request) {
    fail(`Trace ${index} (${event.type}) references unknown requestId ${requestId}`);
  }
  return request;
}

export function assertTraceInvariants(traces: readonly AgentTraceEvent[]): void {
  const sessions = new Set<string>();
  const turns = new Map<string, TurnTraceState>();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let startedCount = 0;
  let stoppedCount = 0;

  for (const [index, event] of traces.entries()) {
    assertTraceTimestamp(event, index);
    if (event.timestamp < previousTimestamp) {
      fail(`Trace ${index} timestamp moved backwards`);
    }
    previousTimestamp = event.timestamp;

    if (!event.sessionId) {
      fail(`Trace ${index} (${event.type}) is missing sessionId`);
    }
    sessions.add(event.sessionId);

    if (event.type.startsWith("_")) {
      fail(`Internal trace type was exposed: ${event.type}`);
    }

    if (event.type === "agent:started") startedCount++;
    if (event.type === "agent:stopped") stoppedCount++;

    if (needsTurnId(event.type)) {
      assertTurnId(event, index);
    }
    if (needsRequestId(event.type)) {
      assertRequestId(event, index);
    }
    if (
      (event.type === "speech:start" || event.type === "speech:end") &&
      event.data?.speaking === true &&
      !event.turnId
    ) {
      fail(`Trace ${index} (${event.type}) is missing turnId while AI is speaking`);
    }

    if (event.type === "ai-turn:started") {
      const turnId = assertTurnId(event, index);
      if (turns.has(turnId)) {
        fail(`Trace ${index} duplicated ai-turn:started for turnId ${turnId}`);
      }
      turns.set(turnId, {
        turnId,
        startedAt: event.timestamp,
        llmFirstTokenSeen: false,
        audioDrops: 0,
        ttsRequests: new Map(),
      });
      continue;
    }

    const turnId = event.turnId;
    const turn =
      turnId && referencesAITurn(event) ? getTurn(turns, turnId, event, index) : undefined;

    if (turn?.terminalType === "ai-turn:interrupted" && isOutputAfterTerminal(event.type)) {
      fail(`Trace ${index} (${event.type}) emitted output after interruption`);
    }

    if (event.type === "llm:start" && turn) {
      if (turn.llmStartedAt !== undefined) {
        fail(`Trace ${index} duplicated llm:start for turnId ${turn.turnId}`);
      }
      turn.llmStartedAt = event.timestamp;
    } else if (event.type === "llm:first-token" && turn) {
      if (turn.llmFirstTokenSeen) {
        fail(`Trace ${index} duplicated llm:first-token for turnId ${turn.turnId}`);
      }
      turn.llmFirstTokenSeen = true;
    } else if (event.type === "llm:complete" && turn) {
      if (turn.llmCompletedAt !== undefined) {
        fail(`Trace ${index} duplicated llm:complete for turnId ${turn.turnId}`);
      }
      turn.llmCompletedAt = event.timestamp;
    } else if (event.type === "tts:start" && turn) {
      const requestId = assertRequestId(event, index);
      if (turn.ttsRequests.has(requestId)) {
        fail(`Trace ${index} duplicated tts:start for requestId ${requestId}`);
      }
      turn.ttsRequests.set(requestId, {
        turnId: turn.turnId,
        requestId,
        startedAt: event.timestamp,
        firstAudioSeen: false,
      });
    } else if (event.type.startsWith("tts:") && event.type !== "tts:queue" && turn) {
      const requestId = assertRequestId(event, index);
      const request = getRequest(turn, requestId, event, index);
      if (request.terminalAt !== undefined && event.type !== "tts:abort") {
        fail(
          `Trace ${index} (${event.type}) emitted after ${request.terminalType} for requestId ${requestId}`,
        );
      }
      if (event.type === "tts:first-audio") {
        if (request.firstAudioSeen) {
          fail(`Trace ${index} duplicated tts:first-audio for requestId ${requestId}`);
        }
        request.firstAudioSeen = true;
      }
      if (
        event.type === "tts:complete" ||
        event.type === "tts:error" ||
        event.type === "tts:abort"
      ) {
        if (request.terminalAt !== undefined) {
          fail(`Trace ${index} duplicated TTS terminal for requestId ${requestId}`);
        }
        request.terminalAt = event.timestamp;
        request.terminalType = event.type;
      }
    } else if (event.type === "audio:drop" && turn) {
      turn.audioDrops++;
    } else if ((event.type === "ai-turn:ended" || event.type === "ai-turn:interrupted") && turn) {
      if (turn.terminalAt !== undefined) {
        fail(
          `Trace ${index} emitted ${event.type} after ${turn.terminalType} for turnId ${turn.turnId}`,
        );
      }
      if (event.type === "ai-turn:ended" && turn.llmCompletedAt === undefined) {
        fail(`Trace ${index} emitted ai-turn:ended before llm:complete`);
      }
      turn.terminalAt = event.timestamp;
      turn.terminalType = event.type;
    }
  }

  if (sessions.size > 1) {
    fail(`Trace capture contains multiple sessionIds: ${Array.from(sessions).join(", ")}`);
  }
  if (startedCount > 1) {
    fail("agent:started trace must be emitted at most once");
  }
  if (stoppedCount > 1) {
    fail("agent:stopped trace must be emitted at most once");
  }
}

function elapsedSince(at: number | undefined, start: number): number | undefined {
  return at === undefined ? undefined : Math.max(0, at - start);
}

export function collectTraceLatencies(traces: readonly AgentTraceEvent[]): TraceTurnLatency[] {
  const turns = new Map<string, TraceTurnLatency>();

  const getOrCreateTurn = (turnId: string, timestamp: number): TraceTurnLatency => {
    let turn = turns.get(turnId);
    if (!turn) {
      turn = { turnId, startedAt: timestamp, audioDrops: 0 };
      turns.set(turnId, turn);
    }
    return turn;
  };

  for (const event of traces) {
    const turnId = event.turnId;
    if (!turnId || !referencesAITurn(event)) continue;

    const turn = getOrCreateTurn(turnId, event.timestamp);
    if (event.type === "ai-turn:started") {
      turn.startedAt = event.timestamp;
    } else if (event.type === "ai-turn:committed") {
      turn.committedAt = event.timestamp;
    } else if (event.type === "llm:first-token") {
      turn.firstTokenAt ??= event.timestamp;
    } else if (event.type === "llm:sentence") {
      turn.firstSentenceAt ??= event.timestamp;
    } else if (event.type === "tts:first-audio") {
      turn.firstTTSAudioAt ??= event.timestamp;
    } else if (event.type === "audio:send") {
      turn.firstAudioSendAt ??= event.timestamp;
    } else if (event.type === "speech:start" && event.data?.speaking === true) {
      turn.interruptionSpeechStartedAt ??= event.timestamp;
    } else if (event.type === "interruption:pending") {
      turn.interruptionPendingAt ??= event.timestamp;
    } else if (event.type === "ai-turn:ended") {
      turn.endedAt = event.timestamp;
    } else if (event.type === "ai-turn:interrupted") {
      turn.interruptedAt = event.timestamp;
    } else if (event.type === "audio:drop") {
      turn.audioDrops++;
    }
  }

  return Array.from(turns.values()).map((turn) => {
    const terminalAt = turn.endedAt ?? turn.interruptedAt;
    // A speculative turn's work before its commit is free from the listener's point of view.
    const from = turn.committedAt ?? turn.startedAt;
    return {
      ...turn,
      timeToFirstTokenMs: elapsedSince(turn.firstTokenAt, from),
      timeToFirstSentenceMs:
        turn.firstSentenceAt === undefined
          ? undefined
          : turn.firstSentenceAt - (turn.firstTokenAt ?? turn.startedAt),
      timeToFirstAudioMs:
        turn.firstTTSAudioAt === undefined
          ? undefined
          : turn.firstTTSAudioAt - (turn.firstSentenceAt ?? turn.startedAt),
      timeToFirstAudioFromTurnStartMs: elapsedSince(turn.firstTTSAudioAt, from),
      timeToAudioSendFromTurnStartMs: elapsedSince(turn.firstAudioSendAt, from),
      audioSendLagMs:
        turn.firstTTSAudioAt === undefined
          ? undefined
          : elapsedSince(turn.firstAudioSendAt, Math.max(turn.firstTTSAudioAt, from)),
      totalDurationMs: elapsedSince(terminalAt, from),
      interruptionPendingLatencyMs:
        turn.interruptionSpeechStartedAt === undefined || turn.interruptionPendingAt === undefined
          ? undefined
          : turn.interruptionPendingAt - turn.interruptionSpeechStartedAt,
      interruptionConfirmLatencyMs:
        turn.interruptionSpeechStartedAt === undefined || turn.interruptedAt === undefined
          ? undefined
          : turn.interruptedAt - turn.interruptionSpeechStartedAt,
    };
  });
}

function assertBudget(
  failures: string[],
  label: string,
  actual: number | undefined,
  maxValue: number | undefined,
): void {
  if (actual === undefined || maxValue === undefined) return;
  if (actual > maxValue) {
    failures.push(`${label}: ${actual}ms > ${maxValue}ms`);
  }
}

export function assertTraceLatencyBudgets(
  traces: readonly AgentTraceEvent[],
  budgets: TraceLatencyBudgets = DEFAULT_TRACE_LATENCY_BUDGETS,
): void {
  const latencies = collectTraceLatencies(traces);
  const failures: string[] = [];
  const audioDrops = latencies.reduce((sum, turn) => sum + turn.audioDrops, 0);

  if (budgets.maxAudioDrops !== undefined && audioDrops > budgets.maxAudioDrops) {
    failures.push(`audio drops: ${audioDrops} > ${budgets.maxAudioDrops}`);
  }

  for (const turn of latencies) {
    const prefix = `turn ${turn.turnId}`;
    assertBudget(
      failures,
      `${prefix} time to first token`,
      turn.timeToFirstTokenMs,
      budgets.maxTimeToFirstTokenMs,
    );
    assertBudget(
      failures,
      `${prefix} time to first sentence`,
      turn.timeToFirstSentenceMs,
      budgets.maxTimeToFirstSentenceMs,
    );
    assertBudget(
      failures,
      `${prefix} sentence to first audio`,
      turn.timeToFirstAudioMs,
      budgets.maxTimeToFirstAudioMs,
    );
    assertBudget(
      failures,
      `${prefix} turn to first audio`,
      turn.timeToFirstAudioFromTurnStartMs,
      budgets.maxTimeToFirstAudioFromTurnStartMs,
    );
    assertBudget(
      failures,
      `${prefix} turn to audio send`,
      turn.timeToAudioSendFromTurnStartMs,
      budgets.maxTimeToAudioSendFromTurnStartMs,
    );
    assertBudget(
      failures,
      `${prefix} audio send lag`,
      turn.audioSendLagMs,
      budgets.maxAudioSendLagMs,
    );
    assertBudget(
      failures,
      `${prefix} total duration`,
      turn.totalDurationMs,
      budgets.maxTurnDurationMs,
    );
    assertBudget(
      failures,
      `${prefix} interruption pending`,
      turn.interruptionPendingLatencyMs,
      budgets.maxInterruptionPendingMs,
    );
    assertBudget(
      failures,
      `${prefix} interruption confirm`,
      turn.interruptionConfirmLatencyMs,
      budgets.maxInterruptionConfirmMs,
    );
  }

  if (failures.length > 0) {
    throw new ScenarioAssertionError(["Trace latency budgets failed", ...failures].join("\n"));
  }
}
