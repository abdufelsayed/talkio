/**
 * STT (Speech-to-Text) Actor
 *
 * Bridges the STT provider and the agent machine: forwards input audio,
 * reports transcripts, and reports voice activity when no VAD provider is
 * configured. With a VAD provider, the STT provider's speech events are
 * ignored so the machine has exactly one voice source.
 *
 * @module agent/actors/stt
 */

import { fromCallback } from "xstate";

import type { NormalizedAgentConfig } from "../../types/config";
import type { MachineEvent } from "../../types/events";
import { clearConfigTimeout, getConfigNow, setConfigTimeout, type TimeoutHandle } from "../time";

/**
 * STT speech events are not reliably paired: providers report speech starts
 * on noise and may never report an end when no words were recognized. Voice
 * activity therefore also ends on a final transcript, or after this long
 * without any transcript.
 */
export const STT_VOICE_IDLE_TIMEOUT_MS = 2000;

export const sttActor = fromCallback<
  MachineEvent,
  {
    config: NormalizedAgentConfig;
    abortSignal: AbortSignal;
  }
>(({ sendBack, receive, input }) => {
  const { config, abortSignal } = input;
  const provider = config.stt;
  const debug = config.debug ?? false;
  const reportsVoice = !config.vad;
  const now = () => getConfigNow(config);
  let voiceStartedAt: number | null = null;
  let voiceIdleTimer: TimeoutHandle | null = null;
  let stopped = false;

  const isActive = () => !stopped && !abortSignal.aborted;

  const reportError = (error: unknown) => {
    if (!isActive()) return;
    if (debug) console.error("[stt-actor] Error:", error);
    sendBack({
      type: "_stt:error",
      error: error instanceof Error ? error : new Error(String(error)),
      timestamp: now(),
    });
  };

  const clearVoiceIdleTimer = () => {
    if (voiceIdleTimer !== null) clearConfigTimeout(config, voiceIdleTimer);
    voiceIdleTimer = null;
  };

  const endVoice = () => {
    clearVoiceIdleTimer();
    if (!isActive() || voiceStartedAt === null) return;
    const timestamp = now();
    const durationMs = Math.max(0, timestamp - voiceStartedAt);
    voiceStartedAt = null;
    sendBack({ type: "_voice:end", source: "stt", durationMs, timestamp });
  };

  const refreshVoiceIdleTimer = () => {
    clearVoiceIdleTimer();
    voiceIdleTimer = setConfigTimeout(config, endVoice, STT_VOICE_IDLE_TIMEOUT_MS);
  };

  if (!isActive()) return () => {};

  try {
    provider.start({
      audioFormat: config.audio.input,
      transcript: (text, isFinal) => {
        if (!isActive()) return;
        sendBack({ type: "_stt:transcript", text, isFinal, timestamp: now() });
        if (!reportsVoice || voiceStartedAt === null) return;
        if (isFinal) {
          endVoice();
        } else {
          refreshVoiceIdleTimer();
        }
      },
      speechStart: () => {
        if (!isActive() || !reportsVoice || voiceStartedAt !== null) return;
        voiceStartedAt = now();
        refreshVoiceIdleTimer();
        sendBack({ type: "_voice:start", source: "stt", timestamp: voiceStartedAt });
      },
      speechEnd: () => {
        if (reportsVoice) endVoice();
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
      provider.sendAudio(event.audio);
    } catch (error) {
      reportError(error);
    }
  });

  return () => {
    stopped = true;
    clearVoiceIdleTimer();
    try {
      provider.stop();
    } catch (error) {
      if (debug) console.error("[stt-actor] Error stopping provider:", error);
    }
  };
});
