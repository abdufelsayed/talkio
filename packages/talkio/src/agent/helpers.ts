/**
 * Builders for the metrics objects attached to public turn events.
 *
 * @module agent/helpers
 */

import type { AITurnMetrics, HumanTurnMetrics, MetricsTrackingState } from "../types/metrics";

export function buildAITurnMetrics(
  metrics: MetricsTrackingState,
  wasInterrupted: boolean,
  now: number,
): AITurnMetrics {
  const m = metrics;
  const aiTurnEndTime = m.aiTurnEndTime ?? now;
  return {
    timeToFirstToken:
      m.firstTokenTime !== null && m.aiTurnStartTime !== null
        ? Math.max(0, m.firstTokenTime - m.aiTurnStartTime)
        : 0,
    timeToFirstSentence:
      m.firstSentenceTime !== null && m.firstTokenTime !== null
        ? m.firstSentenceTime - m.firstTokenTime
        : 0,
    timeToFirstAudio:
      m.firstAudioTime !== null && m.firstSentenceTime !== null
        ? m.firstAudioTime - m.firstSentenceTime
        : 0,
    totalDuration: m.aiTurnStartTime !== null ? aiTurnEndTime - m.aiTurnStartTime : 0,
    tokenCount: m.currentTokenCount,
    sentenceCount: m.currentSentenceCount,
    responseLength: m.currentResponseLength,
    audioChunkCount: m.currentAudioChunkCount,
    totalAudioSamples: m.currentAudioSamples,
    wasInterrupted,
  };
}

export function buildHumanTurnMetrics(metrics: MetricsTrackingState): HumanTurnMetrics {
  return {
    speechDuration: metrics.humanSpeechDuration,
    transcriptLength: metrics.humanTranscriptLength,
  };
}
