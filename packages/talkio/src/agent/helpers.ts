/**
 * Agent Helper Functions
 *
 * Pure helper functions extracted from the state machine for better
 * testability and reusability. These functions handle metric calculations
 * and common transformations used across multiple actions.
 *
 * @module agent/helpers
 */

import type { AITurnMetrics, MetricsTrackingState } from "../types/metrics";

/**
 * Builds the AITurnMetrics object from the current metrics tracking state.
 * Used when emitting ai-turn:ended events.
 */
export function buildAITurnMetrics(
  metrics: MetricsTrackingState,
  wasInterrupted = false,
  now = Date.now(),
): AITurnMetrics {
  const m = metrics;
  const aiTurnEndTime = m.aiTurnEndTime ?? now;
  return {
    timeToFirstToken:
      m.firstTokenTime && m.aiTurnStartTime ? m.firstTokenTime - m.aiTurnStartTime : 0,
    timeToFirstSentence:
      m.firstSentenceTime && m.firstTokenTime ? m.firstSentenceTime - m.firstTokenTime : 0,
    timeToFirstAudio:
      m.firstAudioTime && m.firstSentenceTime ? m.firstAudioTime - m.firstSentenceTime : 0,
    totalDuration: m.aiTurnStartTime ? aiTurnEndTime - m.aiTurnStartTime : 0,
    tokenCount: m.currentTokenCount,
    sentenceCount: m.currentSentenceCount,
    responseLength: m.currentResponseLength,
    audioChunkCount: m.currentAudioChunkCount,
    totalAudioSamples: m.currentAudioSamples,
    wasInterrupted,
  };
}

/**
 * Builds the HumanTurnMetrics from the current metrics tracking state.
 */
export function buildHumanTurnMetrics(metrics: MetricsTrackingState) {
  return {
    speechDuration: metrics.humanSpeechDuration,
    transcriptLength: metrics.humanTranscriptLength,
  };
}

/**
 * Gets the text for TTS based on the source type.
 * Returns empty string if the source/event combination is invalid.
 */
export function getTTSText(
  source: "queue" | "sentence" | "filler",
  sentenceQueue: string[],
  event: { type: string; sentence?: string; text?: string },
): string {
  switch (source) {
    case "queue":
      return sentenceQueue[0] ?? "";
    case "sentence":
      return event.type === "_llm:sentence" ? (event.sentence ?? "") : "";
    case "filler":
      return event.type === "_filler:say" ? (event.text ?? "") : "";
    default:
      return "";
  }
}
