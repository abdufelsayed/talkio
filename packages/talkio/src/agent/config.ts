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
    pendingAudio: config?.pendingAudio ?? "pause",
  };
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
  };
}
