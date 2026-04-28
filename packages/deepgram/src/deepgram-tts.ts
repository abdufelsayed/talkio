/**
 * Deepgram Text-to-Speech Provider
 *
 * Implementation of the TTS provider interface for Deepgram's streaming TTS API.
 *
 * This module provides a fully-typed TTS provider that connects to Deepgram's
 * WebSocket API for real-time speech synthesis. It handles:
 * - WebSocket connection management and lifecycle
 * - Audio format configuration and validation
 * - Real-time audio chunk streaming
 * - Error handling and reconnection
 * - Audio buffering before connection is ready
 *
 * **Supported Audio Formats**:
 * - `linear16` - 16-bit PCM at 8000, 16000, 24000, 32000, or 48000 Hz (default: 24000)
 * - `mulaw` - Mu-law encoding at 8000 or 16000 Hz (default: 8000)
 * - `alaw` - A-law encoding at 8000 or 16000 Hz (default: 8000)
 *
 * The provider is strongly typed with its supported output formats, enabling
 * compile-time validation when configuring audio in `createAgent()`.
 *
 * @module deepgram/deepgram-tts
 */

import type { TTSContext, TTSProvider } from "talkio";

import type { DeepgramProviderSettings, DeepgramTTSMessage, DeepgramTTSOptions } from "./types";

const DEFAULT_BASE_URL = "api.deepgram.com";
const DEFAULT_TTS_ENCODING = "linear16";
const DEFAULT_TTS_LINEAR16_SAMPLE_RATE = 24000;
const DEFAULT_TTS_TELEPHONY_SAMPLE_RATE = 8000;

/**
 * Encoding configuration for Deepgram TTS.
 *
 * Each encoding specifies its supported sample rates and channel counts.
 * TTS output is mono for voice synthesis.
 */
const DEEPGRAM_TTS_ENCODING_CONFIG = {
  linear16: { sampleRates: [8000, 16000, 24000, 32000, 48000], channels: [1] },
  mulaw: { sampleRates: [8000, 16000], channels: [1] },
  alaw: { sampleRates: [8000, 16000], channels: [1] },
} as const;

/**
 * Supported encoding types for Deepgram TTS.
 */
export type DeepgramTTSEncodingType = keyof typeof DEEPGRAM_TTS_ENCODING_CONFIG;

/**
 * Output format type for Deepgram TTS with per-encoding type narrowing.
 *
 * Each encoding constrains sampleRate to valid values.
 */
export type DeepgramTTSOutputFormat = {
  [E in DeepgramTTSEncodingType]: {
    encoding: E;
    sampleRate?: (typeof DEEPGRAM_TTS_ENCODING_CONFIG)[E]["sampleRates"][number];
    channels?: (typeof DEEPGRAM_TTS_ENCODING_CONFIG)[E]["channels"][number];
  };
}[DeepgramTTSEncodingType];

function generateSupportedFormats(): readonly DeepgramTTSOutputFormat[] {
  const formats: DeepgramTTSOutputFormat[] = [];
  for (const [encoding, config] of Object.entries(DEEPGRAM_TTS_ENCODING_CONFIG)) {
    for (const sampleRate of config.sampleRates) {
      for (const channels of config.channels) {
        formats.push({
          encoding,
          sampleRate,
          channels,
        } as DeepgramTTSOutputFormat);
      }
    }
  }
  return formats;
}

const SUPPORTED_OUTPUT_FORMATS = generateSupportedFormats();

/**
 * Resolve the API key from options, settings, or environment variable.
 */
function resolveApiKey(optionsApiKey?: string, settingsApiKey?: string): string {
  const apiKey =
    optionsApiKey ??
    settingsApiKey ??
    (typeof process !== "undefined" ? process.env?.DEEPGRAM_API_KEY : undefined);

  if (!apiKey) {
    throw new Error(
      "Deepgram API key is required. Provide it via options, provider settings, or DEEPGRAM_API_KEY environment variable.",
    );
  }

  return apiKey;
}

/**
 * Map AudioEncoding to Deepgram TTS encoding.
 *
 * Supported streaming TTS encodings:
 * - linear16 (default)
 * - mulaw
 * - alaw
 */
function mapEncodingToDeepgram(encoding: string): string {
  switch (encoding) {
    case "linear16":
    case "mulaw":
    case "alaw":
      return encoding;
    default:
      return DEFAULT_TTS_ENCODING;
  }
}

/**
 * Get the default sample rate for a given TTS encoding.
 */
function getDefaultSampleRate(encoding: string): number {
  switch (encoding) {
    case "mulaw":
    case "alaw":
      return DEFAULT_TTS_TELEPHONY_SAMPLE_RATE;
    default:
      return DEFAULT_TTS_LINEAR16_SAMPLE_RATE;
  }
}

function resolveDefaultOutputFormat(options: DeepgramTTSOptions): DeepgramTTSOutputFormat {
  const encoding = mapEncodingToDeepgram(options.encoding ?? DEFAULT_TTS_ENCODING);
  const sampleRate = options.sampleRate ?? getDefaultSampleRate(encoding);
  const format = SUPPORTED_OUTPUT_FORMATS.find(
    (supported) =>
      supported.encoding === encoding &&
      supported.sampleRate === sampleRate &&
      supported.channels === 1,
  );

  if (!format) {
    throw new Error(`Unsupported Deepgram TTS output format: ${encoding}/${sampleRate}/1`);
  }

  return format;
}

/**
 * Create a Deepgram TTS provider for streaming text-to-speech.
 *
 * This provider connects to Deepgram's streaming WebSocket API for real-time
 * speech synthesis. It supports multiple audio encodings and voice models.
 *
 * Supported audio encodings for streaming:
 * - `linear16` - 16-bit signed little-endian PCM (default, recommended)
 *   - Supported sample rates: 8000, 16000, 24000, 32000, 48000 Hz
 *   - Default: 24000 Hz (high quality voice)
 * - `mulaw` - Mu-law encoding (telephony, G.711)
 *   - Supported sample rates: 8000, 16000 Hz
 *   - Default: 8000 Hz
 * - `alaw` - A-law encoding (telephony, G.711)
 *   - Supported sample rates: 8000, 16000 Hz
 *   - Default: 8000 Hz
 *
 * The provider automatically handles:
 * - WebSocket connection management
 * - Streaming audio chunks as they arrive
 * - Error handling and cleanup
 *
 * @param options - TTS configuration options (model, encoding, sample rate, API key, etc.)
 * @param providerSettings - Optional provider-level settings (API key, base URL)
 *   These are used as fallbacks if not specified in options.
 * @returns A typed TTS provider that can be used in createAgent
 *
 * @see https://developers.deepgram.com/docs/tts-media-output-settings
 * @see https://developers.deepgram.com/docs/tts-models
 *
 * @example Basic usage
 * ```typescript
 * import { createDeepgramTTS } from "@talkio/deepgram";
 *
 * const tts = createDeepgramTTS({
 *   apiKey: process.env.DEEPGRAM_API_KEY,
 *   model: "aura-2-thalia-en",
 * });
 * ```
 *
 * @example With custom encoding and sample rate
 * ```typescript
 * const tts = createDeepgramTTS({
 *   apiKey: process.env.DEEPGRAM_API_KEY,
 *   model: "aura-2-thalia-en",
 *   encoding: "linear16",
 *   sampleRate: 48000, // High quality
 * });
 * ```
 *
 * @example Telephony format
 * ```typescript
 * const tts = createDeepgramTTS({
 *   apiKey: process.env.DEEPGRAM_API_KEY,
 *   model: "aura-2-thalia-en",
 *   encoding: "mulaw",
 *   sampleRate: 8000, // Telephony standard
 * });
 * ```
 */
export function createDeepgramTTS(
  options: DeepgramTTSOptions,
  providerSettings: DeepgramProviderSettings = {},
): TTSProvider<DeepgramTTSOutputFormat> {
  const { model } = options;

  const baseUrl = options.baseUrl ?? providerSettings.baseUrl ?? DEFAULT_BASE_URL;
  const defaultOutputFormat = resolveDefaultOutputFormat(options);

  return {
    metadata: {
      name: "Deepgram",
      version: "0.1.0",
      type: "tts",
      supportedOutputFormats: SUPPORTED_OUTPUT_FORMATS,
      defaultOutputFormat,
    },

    synthesize(text: string, ctx: TTSContext): void {
      const apiKey = resolveApiKey(options.apiKey, providerSettings.apiKey);

      if (ctx.signal.aborted) {
        return;
      }

      const params = new URLSearchParams();
      params.set("model", model);
      params.set("encoding", mapEncodingToDeepgram(ctx.audioFormat.encoding));
      params.set("sample_rate", ctx.audioFormat.sampleRate.toString());

      const url = `wss://${baseUrl}/v1/speak?${params.toString()}`;

      let ws: WebSocket | null = null;
      let hasReceivedAudio = false;
      let isCompleted = false;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (abortHandler) {
          ctx.signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
        if (ws) {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "Close" }));
            } catch {
              // Ignore send errors during cleanup
            }
          }
          ws.close();
          ws = null;
        }
      };

      abortHandler = cleanup;
      ctx.signal.addEventListener("abort", abortHandler);

      try {
        ws = new WebSocket(url, ["token", apiKey]);
        ws.binaryType = "arraybuffer";

        ws.addEventListener("open", () => {
          if (ctx.signal.aborted) {
            cleanup();
            return;
          }

          ws?.send(JSON.stringify({ type: "Speak", text }));
          ws?.send(JSON.stringify({ type: "Flush" }));
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          if (ctx.signal.aborted || isCompleted) {
            cleanup();
            return;
          }

          if (event.data instanceof ArrayBuffer) {
            hasReceivedAudio = true;
            ctx.audioChunk(event.data);
            return;
          }

          if (ArrayBuffer.isView(event.data)) {
            hasReceivedAudio = true;
            const buffer = event.data.buffer.slice(
              event.data.byteOffset,
              event.data.byteOffset + event.data.byteLength,
            ) as ArrayBuffer;
            ctx.audioChunk(buffer);
            return;
          }

          try {
            const message: DeepgramTTSMessage = JSON.parse(event.data as string);

            switch (message.type) {
              case "Flushed": {
                isCompleted = true;
                ctx.complete();
                cleanup();
                break;
              }

              case "Warning": {
                console.warn(`Deepgram TTS warning: ${message.warn_msg}`);
                break;
              }

              case "Error": {
                ctx.error(new Error(`Deepgram TTS error: ${message.err_msg}`));
                cleanup();
                break;
              }
            }
          } catch {
            // Ignore non-JSON messages
          }
        });

        ws.addEventListener("error", (event) => {
          if (!ctx.signal.aborted && !isCompleted) {
            ctx.error(
              new Error(
                `Deepgram TTS WebSocket error: ${(event as ErrorEvent).message ?? "Unknown error"}`,
              ),
            );
          }
          cleanup();
        });

        ws.addEventListener("close", (event) => {
          if (
            event.code !== 1000 &&
            event.code !== 1005 &&
            !ctx.signal.aborted &&
            !isCompleted &&
            !hasReceivedAudio
          ) {
            ctx.error(
              new Error(`Deepgram TTS WebSocket closed: ${event.reason || `code ${event.code}`}`),
            );
          }
          cleanup();
        });
      } catch (error) {
        if (!ctx.signal.aborted) {
          ctx.error(
            error instanceof Error ? error : new Error("Failed to connect to Deepgram TTS"),
          );
        }
        cleanup();
      }
    },
  };
}
