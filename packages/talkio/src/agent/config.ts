import { normalizeFormat, type AudioFormat } from "../audio/types";
import type { STTProvider, TTSProvider } from "../providers/types";
import type {
  AgentConfig,
  InterruptionConfig,
  NormalizedAgentConfig,
  ResolvedInterruptionConfig,
} from "../types/config";
import { resolveTurnDetector } from "./turn-detectors";
import { resolveTurnTakingConfig } from "./turn-taking";

export const DEFAULT_INTERRUPTION_MIN_DURATION_MS = 200;

/** `true` or options turn a feature on, `false` turns it off. */
function toggle<T extends object>(
  value: boolean | T | undefined,
  enabledByDefault: boolean,
): { enabled: boolean; options: Partial<T> } {
  if (typeof value === "object") return { enabled: true, options: value };
  return { enabled: value ?? enabledByDefault, options: {} };
}

export function resolveInterruptionConfig(
  value: boolean | InterruptionConfig | undefined,
): ResolvedInterruptionConfig {
  const { enabled, options: config } = toggle(value, true);
  const minDurationMs = Math.max(0, config.minDurationMs ?? DEFAULT_INTERRUPTION_MIN_DURATION_MS);
  return {
    enabled,
    minDurationMs,
    pauseAfterMs: Math.min(Math.max(config.pauseAfterMs ?? 0, 0), minDurationMs),
    minWords: config.minWords ?? 2,
    minChars: config.minChars ?? 3,
    resumeAfterMs: Math.max(0, config.resumeAfterMs ?? 600),
    maxPendingMs: Math.max(0, config.maxPendingMs ?? 3000),
    classifier: config.classifier,
    pendingAudio: config.pendingAudio ?? "pause",
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
  const fillers = toggle(config.fillers, false);
  const backchannels = toggle(config.backchannels, false);
  const silence = toggle(config.silence, false);
  return {
    ...config,
    sessionId,
    audio: {
      input: normalizeFormat(config.audio?.input ?? config.stt.metadata.defaultInputFormat),
      output: normalizeFormat(config.audio?.output ?? config.tts.metadata.defaultOutputFormat),
    },
    turnDetector: resolveTurnDetector(config.turnDetector),
    interruption: resolveInterruptionConfig(config.interruption),
    turnTaking: resolveTurnTakingConfig(config.turnTaking),
    playback: { outputLatencyMs: Math.max(0, config.playback?.outputLatencyMs ?? 0) },
    fillers: {
      enabled: fillers.enabled,
      afterMs: Math.max(0, fillers.options.afterMs ?? 1200),
      phrases: nonEmpty(fillers.options.phrases, [
        "One moment.",
        "Let me check.",
        "Hmm, let me think.",
      ]),
    },
    backchannels: {
      enabled: backchannels.enabled,
      phrases: nonEmpty(backchannels.options.phrases, ["Mm-hmm.", "Uh-huh.", "Okay.", "Right."]),
      minSpeechMs: Math.max(0, backchannels.options.minSpeechMs ?? 4000),
      pauseMs: Math.max(0, backchannels.options.pauseMs ?? 400),
      maxEndOfTurnProbability: backchannels.options.maxEndOfTurnProbability ?? 0.3,
    },
    silence: {
      enabled: silence.enabled,
      afterMs: Math.max(0, silence.options.afterMs ?? 5000),
      startMode: silence.options.startMode ?? "afterFirstSpeech",
      prompt: silence.options.prompt ?? "Are you still there?",
      maxPrompts: silence.options.maxPrompts ?? 3,
    },
  };
}
