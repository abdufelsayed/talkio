import type { PublicAgentEvent } from "talkio";

import {
  assertEventInvariants,
  assertEventSequence,
  ScenarioAssertionError,
  type EventType,
  type RecordedEvent,
} from "./assertions";

type EventCaptureOptions = {
  defaultTimeoutMs?: number;
  now?: () => number;
};

type WaitOptions = {
  fromIndex?: number;
  timeoutMs?: number;
};

export type TypedRecordedEvent<T extends EventType> = RecordedEvent & {
  event: PublicAgentEvent & { type: T };
  index: number;
};

type EventWaiter<T extends EventType = EventType> = {
  type: T;
  fromIndex: number;
  resolve: (recorded: TypedRecordedEvent<T>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type EventCapture = {
  events: RecordedEvent[];
  onEvent: (event: PublicAgentEvent) => void;
  byType: <T extends EventType>(type: T) => Array<PublicAgentEvent & { type: T }>;
  findEvent: <T extends EventType>(
    type: T,
    fromIndex?: number,
  ) => { event: PublicAgentEvent & { type: T }; index: number } | undefined;
  waitForEvent: <T extends EventType>(
    type: T,
    options?: WaitOptions,
  ) => Promise<PublicAgentEvent & { type: T }>;
  waitForRecordedEvent: <T extends EventType>(
    type: T,
    options?: WaitOptions,
  ) => Promise<TypedRecordedEvent<T>>;
  assertInvariants: () => void;
  assertSequence: (types: EventType[]) => void;
};

const DEFAULT_TIMEOUT_MS = 1000;

export function createEventCapture(options: EventCaptureOptions = {}): EventCapture {
  const events: RecordedEvent[] = [];
  const waiters: EventWaiter[] = [];
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const findEvent = <T extends EventType>(
    type: T,
    fromIndex = 0,
  ): { event: PublicAgentEvent & { type: T }; index: number } | undefined => {
    for (let index = fromIndex; index < events.length; index++) {
      const event = events[index]?.event;
      if (event?.type === type) {
        return { event: event as PublicAgentEvent & { type: T }, index };
      }
    }
    return undefined;
  };

  const flushWaiters = (): void => {
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index];
      if (!waiter) continue;
      const match = findEvent(waiter.type, waiter.fromIndex);
      if (!match) continue;
      clearTimeout(waiter.timer);
      waiters.splice(index, 1);
      const recorded = events[match.index];
      if (!recorded) continue;
      waiter.resolve({
        ...recorded,
        event: match.event,
        index: match.index,
      });
    }
  };

  const onEvent = (event: PublicAgentEvent): void => {
    events.push({ event, receivedAt: now() });
    flushWaiters();
  };

  const byType = <T extends EventType>(type: T): Array<PublicAgentEvent & { type: T }> => {
    return events
      .filter(
        (entry): entry is RecordedEvent & { event: PublicAgentEvent & { type: T } } =>
          entry.event.type === type,
      )
      .map((entry) => entry.event);
  };

  const waitForRecordedEvent = <T extends EventType>(
    type: T,
    waitOptions: WaitOptions = {},
  ): Promise<TypedRecordedEvent<T>> => {
    const fromIndex = waitOptions.fromIndex ?? 0;
    const existing = findEvent(type, fromIndex);
    if (existing) {
      const recorded = events[existing.index];
      if (recorded) {
        return Promise.resolve({
          ...recorded,
          event: existing.event,
          index: existing.index,
        });
      }
    }

    const timeoutMs = waitOptions.timeoutMs ?? defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) {
          waiters.splice(waiterIndex, 1);
        }
        reject(new ScenarioAssertionError(`Timed out waiting for event ${type}`));
      }, timeoutMs);

      waiters.push({
        type,
        fromIndex,
        resolve,
        reject,
        timer,
      } as EventWaiter);
    });
  };

  const waitForEvent = async <T extends EventType>(
    type: T,
    waitOptions: WaitOptions = {},
  ): Promise<PublicAgentEvent & { type: T }> => {
    const recorded = await waitForRecordedEvent(type, waitOptions);
    return recorded.event;
  };

  return {
    events,
    onEvent,
    byType,
    findEvent,
    waitForEvent,
    waitForRecordedEvent,
    assertInvariants: () => assertEventInvariants(events),
    assertSequence: (types) => assertEventSequence(events, types),
  };
}
