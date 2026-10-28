/**
 * VAD (Voice Activity Detection) Actor
 *
 * Runs the optional VAD provider. When configured, it is the agent's only
 * voice source; dedicated VADs (like Silero) usually detect speech faster
 * than STT, which shortens barge-in latency.
 *
 * @module agent/actors/vad
 */

import { fromCallback } from "xstate";

import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { getConfigNow } from "../time";

export const vadActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    abortSignal: AbortSignal;
  }
>(({ sendBack, receive, input }) => {
  const { config, abortSignal } = input;
  const provider = config.vad;
  const debug = config.debug ?? false;
  const now = () => getConfigNow(config);
  let speaking = false;
  let stopped = false;

  if (!provider || abortSignal.aborted) return () => {};

  const isActive = () => !stopped && !abortSignal.aborted;

  const reportError = (error: unknown) => {
    if (!isActive()) return;
    if (debug) console.error("[vad-actor] Error:", error);
    sendBack({
      type: "_vad:error",
      error: error instanceof Error ? error : new Error(String(error)),
      timestamp: now(),
    });
  };

  try {
    provider.start({
      speechStart: () => {
        if (!isActive() || speaking) return;
        speaking = true;
        sendBack({ type: "_voice:start", source: "vad", timestamp: now() });
      },
      speechEnd: (duration) => {
        if (!isActive() || !speaking) return;
        speaking = false;
        sendBack({
          type: "_voice:end",
          source: "vad",
          durationMs: Math.max(0, duration),
          timestamp: now(),
        });
      },
      speechProbability: (value) => {
        if (!isActive()) return;
        sendBack({ type: "_vad:probability", value, timestamp: now() });
      },
      error: reportError,
      signal: abortSignal,
    });
  } catch (error) {
    reportError(error);
  }

  receive((event) => {
    if (!isActive() || event.type !== "_audio:input") return;
    try {
      provider.processAudio(event.audio);
    } catch (error) {
      reportError(error);
    }
  });

  return () => {
    stopped = true;
    try {
      provider.stop();
    } catch (error) {
      if (debug) console.error("[vad-actor] Error stopping provider:", error);
    }
  };
});
