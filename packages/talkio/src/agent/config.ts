import { normalizeFormat, type AudioFormat } from "../audio/types";
import type { STTProvider, TTSProvider } from "../providers/types";
import type {
  AgentConfig,
  InterruptionConfig,
  NormalizedAgentConfig,
  ResolvedInterruptionConfig,
} from "../types/config";
import { resolveTurnTakingConfig } from "./turn-taking";

export const DEFAULT_INTERRUPTION_MIN_DURATION_MS = 200;

export function resolveInterruptionConfig(
  config: InterruptionConfig | undefined,
): ResolvedInterruptionConfig {
  const minDurationMs = Math.max(0, config?.minDurationMs ?? DEFAULT_INTERRUPTION_MIN_DURATION_MS);
  return {
    enabled: config?.enabled ?? true,
    minDurationMs,
    speculativeCutoffMs: Math.min(Math.max(config?.speculativeCutoffMs ?? 0, 0), minDurationMs),
    interimMinWords: config?.interimMinWords ?? 2,
    interimMinChars: config?.interimMinChars ?? 3,
    resumeAfterMs: Math.max(0, config?.resumeAfterMs ?? 600),
    maxPendingMs: Math.max(0, config?.maxPendingMs ?? 3000),
    classifier: config?.classifier,
    pendingAudio: config?.pendingAudio ?? "pause",
  };
}

function nonEmpty(phrases: string[] | undefined, fallback: string[]): string[] {
  const usable = (phrases ?? []).map((phrase) => phrase.trim()).filter(Boolean);
  return usable.length > 0 ? usable : fallback;
}

export function normalizeAgentConfig<
  STT extends STTProvider<AudioFormat>,
  TTS extends TTSProvider<AudioFormat>,
>(config: AgentConfig<STT, TTS>, sessionId: string): NormalizedAgentConfig {
  return {
    ...config,
    sessionId,
    audio: {
      input: normalizeFormat(config.audio?.input ?? config.stt.metadata.defaultInputFormat),
      output: normalizeFormat(config.audio?.output ?? config.tts.metadata.defaultOutputFormat),
    },
    interruption: resolveInterruptionConfig(config.interruption),
    turnTaking: resolveTurnTakingConfig(config.turnTaking),
    playback: { outputLatencyMs: Math.max(0, config.playback?.outputLatencyMs ?? 0) },
    fillers: {
      enabled: config.fillers?.enabled ?? false,
      afterMs: Math.max(0, config.fillers?.afterMs ?? 1200),
      phrases: nonEmpty(config.fillers?.phrases, [
        "One moment.",
        "Let me check.",
        "Hmm, let me think.",
      ]),
    },
    backchannels: {
      enabled: config.backchannels?.enabled ?? false,
      phrases: nonEmpty(config.backchannels?.phrases, ["Mm-hmm.", "Uh-huh.", "Okay.", "Right."]),
      minSpeechMs: Math.max(0, config.backchannels?.minSpeechMs ?? 4000),
      pauseMs: Math.max(0, config.backchannels?.pauseMs ?? 400),
      maxEndOfTurnProbability: config.backchannels?.maxEndOfTurnProbability ?? 0.3,
    },
  };
}
