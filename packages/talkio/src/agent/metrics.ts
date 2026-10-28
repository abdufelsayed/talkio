/**
 * Pure updates to the metrics tracking state.
 *
 * @module agent/metrics
 */

import type { MetricsTrackingState } from "../types/metrics";

type Metrics = MetricsTrackingState;
type ErrorSource = keyof Metrics["errorsBySource"];

export function recordSessionStart(metrics: Metrics, now: number): Metrics {
  return { ...metrics, sessionStartedAt: now };
}

export function recordHumanTurnStart(metrics: Metrics, now: number): Metrics {
  if (metrics.humanTurnStartTime !== null) return metrics;
  return { ...metrics, humanTurnStartTime: now, totalTurns: metrics.totalTurns + 1 };
}

function clearHumanTurn(metrics: Metrics): Metrics {
  return {
    ...metrics,
    humanTurnStartTime: null,
    humanTurnEndTime: null,
    humanSpeechDuration: 0,
    humanTranscriptLength: 0,
  };
}

export function recordHumanTurnEnd(
  metrics: Metrics,
  now: number,
  speechDuration: number,
  transcriptLength: number,
): Metrics {
  return {
    ...metrics,
    humanTurnEndTime: now,
    humanSpeechDuration: speechDuration,
    humanTranscriptLength: transcriptLength,
    totalUserSpeechDuration: metrics.totalUserSpeechDuration + speechDuration,
    totalUserTranscriptChars: metrics.totalUserTranscriptChars + transcriptLength,
  };
}

export function finishHumanTurn(metrics: Metrics): Metrics {
  return clearHumanTurn(metrics);
}

export function recordHumanTurnAbandoned(metrics: Metrics): Metrics {
  return { ...clearHumanTurn(metrics), abandonedTurns: metrics.abandonedTurns + 1 };
}

export function recordAITurnStart(metrics: Metrics, now: number): Metrics {
  return {
    ...metrics,
    aiTurnStartTime: now,
    firstTokenTime: null,
    firstSentenceTime: null,
    firstAudioTime: null,
    aiTurnEndTime: null,
    currentTokenCount: 0,
    currentSentenceCount: 0,
    currentResponseLength: 0,
    currentAudioChunkCount: 0,
    currentAudioSamples: 0,
  };
}

/** A speculative turn that commits starts counting from the commit. */
export function recordAITurnAdopted(metrics: Metrics, now: number): Metrics {
  return { ...metrics, aiTurnStartTime: now };
}

export function recordToken(metrics: Metrics, now: number, token: string): Metrics {
  return {
    ...metrics,
    firstTokenTime: metrics.firstTokenTime ?? now,
    currentTokenCount: metrics.currentTokenCount + 1,
    currentResponseLength: metrics.currentResponseLength + token.length,
  };
}

export function recordSentence(metrics: Metrics, now: number): Metrics {
  return {
    ...metrics,
    firstSentenceTime: metrics.firstSentenceTime ?? now,
    currentSentenceCount: metrics.currentSentenceCount + 1,
  };
}

export function recordResponseLength(metrics: Metrics, length: number): Metrics {
  if (length <= metrics.currentResponseLength) return metrics;
  return { ...metrics, currentResponseLength: length };
}

export function recordAudioChunk(metrics: Metrics, now: number, samples: number): Metrics {
  return {
    ...metrics,
    firstAudioTime: metrics.firstAudioTime ?? now,
    currentAudioChunkCount: metrics.currentAudioChunkCount + 1,
    currentAudioSamples: metrics.currentAudioSamples + samples,
  };
}

export function recordAITurnComplete(metrics: Metrics, now: number): Metrics {
  const m = metrics;
  const timeToFirstToken =
    m.firstTokenTime !== null && m.aiTurnStartTime !== null
      ? Math.max(0, m.firstTokenTime - m.aiTurnStartTime)
      : 0;
  const timeToFirstAudio =
    m.firstAudioTime !== null && m.aiTurnStartTime !== null
      ? Math.max(0, m.firstAudioTime - m.aiTurnStartTime)
      : 0;
  const turnDuration = m.aiTurnStartTime !== null ? now - m.aiTurnStartTime : 0;
  const speakingDuration = m.firstAudioTime !== null ? now - m.firstAudioTime : 0;

  return {
    ...m,
    aiTurnEndTime: now,
    completedTurns: m.completedTurns + 1,
    completedTurnsForAverage: m.completedTurnsForAverage + 1,
    totalTimeToFirstToken: m.totalTimeToFirstToken + timeToFirstToken,
    totalTimeToFirstAudio: m.totalTimeToFirstAudio + timeToFirstAudio,
    totalTurnDuration: m.totalTurnDuration + turnDuration,
    totalLLMTokens: m.totalLLMTokens + m.currentTokenCount,
    totalResponseChars: m.totalResponseChars + m.currentResponseLength,
    totalAgentSpeakingDuration: m.totalAgentSpeakingDuration + speakingDuration,
    totalAudioChunks: m.totalAudioChunks + m.currentAudioChunkCount,
    totalAudioSamples: m.totalAudioSamples + m.currentAudioSamples,
  };
}

export function recordAITurnInterrupted(metrics: Metrics, now: number): Metrics {
  return { ...metrics, aiTurnEndTime: now, interruptedTurns: metrics.interruptedTurns + 1 };
}

export function recordError(metrics: Metrics, source: ErrorSource): Metrics {
  return {
    ...metrics,
    errorsBySource: {
      ...metrics.errorsBySource,
      [source]: metrics.errorsBySource[source] + 1,
    },
  };
}
