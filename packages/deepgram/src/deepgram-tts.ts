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

import type { TTSContext, TTSProvider, TTSSpeakOptions } from "talkio";

import type { DeepgramProviderSettings, DeepgramTTSMessage, DeepgramTTSOptions } from "./types";

const DEFAULT_BASE_URL = "api.deepgram.com";
const DEFAULT_TTS_ENCODING = "linear16";
const DEFAULT_TTS_LINEAR16_SAMPLE_RATE = 24000;
const DEFAULT_TTS_TELEPHONY_SAMPLE_RATE = 8000;

type PendingTTSCommand = {
  serialized: string;
  bypassClear: boolean;
};

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

const DEFAULT_MODEL = "aura-2-thalia-en";

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
  options: DeepgramTTSOptions = {},
  providerSettings: DeepgramProviderSettings = {},
): TTSProvider<DeepgramTTSOutputFormat> {
  const { model = DEFAULT_MODEL } = options;

  const baseUrl = options.baseUrl ?? providerSettings.baseUrl ?? DEFAULT_BASE_URL;
  const defaultOutputFormat = resolveDefaultOutputFormat(options);
  const apiKey = () => resolveApiKey(options.apiKey, providerSettings.apiKey);

  let ws: WebSocket | null = null;
  let ctx: TTSContext | null = null;
  let isConnected = false;
  let isConnecting = false;
  let isClearing = false;
  let commandQueue: PendingTTSCommand[] = [];
  let abortHandler: (() => void) | null = null;

  function buildUrl(context: TTSContext): string {
    const params = new URLSearchParams();
    params.set("model", model);
    params.set("encoding", mapEncodingToDeepgram(context.audioFormat.encoding));
    params.set("sample_rate", context.audioFormat.sampleRate.toString());
    return `wss://${baseUrl}/v1/speak?${params.toString()}`;
  }

  function flushCommandQueue(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (commandQueue.length > 0) {
      const command = commandQueue[0];
      if (!command) return;
      if (isClearing && !command.bypassClear) return;
      ws.send(command.serialized);
      commandQueue.shift();
    }
  }

  function sendCommand(
    command: Record<string, unknown>,
    commandOptions: { bypassClear?: boolean } = {},
  ): void {
    const serialized = JSON.stringify(command);
    const pendingCommand = { serialized, bypassClear: commandOptions.bypassClear ?? false };
    if (
      isConnected &&
      ws?.readyState === WebSocket.OPEN &&
      (!isClearing || pendingCommand.bypassClear)
    ) {
      ws.send(serialized);
      return;
    }
    commandQueue.push(pendingCommand);
  }

  function cleanup(): void {
    if (abortHandler && ctx) {
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
    isConnected = false;
    isConnecting = false;
    isClearing = false;
    commandQueue = [];
    ctx = null;
  }

  function connect(): void {
    if (!ctx || ctx.signal.aborted || ws || isConnecting) return;

    isConnecting = true;
    try {
      ws = new WebSocket(buildUrl(ctx), ["token", apiKey()]);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        isConnected = true;
        isConnecting = false;
        flushCommandQueue();
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        if (!ctx || ctx.signal.aborted) {
          cleanup();
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          if (isClearing) return;
          ctx.audio(event.data);
          return;
        }

        if (ArrayBuffer.isView(event.data)) {
          if (isClearing) return;
          const buffer = event.data.buffer.slice(
            event.data.byteOffset,
            event.data.byteOffset + event.data.byteLength,
          ) as ArrayBuffer;
          ctx.audio(buffer);
          return;
        }

        try {
          const message: DeepgramTTSMessage = JSON.parse(event.data as string);

          switch (message.type) {
            case "Flushed": {
              ctx.complete();
              break;
            }

            case "Cleared": {
              isClearing = false;
              flushCommandQueue();
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
        if (ctx && !ctx.signal.aborted) {
          ctx.error(
            new Error(
              `Deepgram TTS WebSocket error: ${(event as ErrorEvent).message ?? "Unknown error"}`,
            ),
          );
        }
        cleanup();
      });

      ws.addEventListener("close", (event) => {
        isConnected = false;
        isConnecting = false;
        if (event.code !== 1000 && event.code !== 1005 && ctx && !ctx.signal.aborted) {
          ctx.error(
            new Error(`Deepgram TTS WebSocket closed: ${event.reason || `code ${event.code}`}`),
          );
        }
        ws = null;
      });
    } catch (error) {
      if (ctx && !ctx.signal.aborted) {
        ctx.error(error instanceof Error ? error : new Error("Failed to connect to Deepgram TTS"));
      }
      cleanup();
    }
  }

  return {
    metadata: {
      name: "Deepgram",
      supportedOutputFormats: SUPPORTED_OUTPUT_FORMATS,
      defaultOutputFormat,
    },

    start(context: TTSContext): void {
      ctx = context;
      if (context.signal.aborted) return;
      abortHandler = cleanup;
      context.signal.addEventListener("abort", abortHandler);
      connect();
    },

    speak(text: string, _options: TTSSpeakOptions): void {
      if (!ctx || ctx.signal.aborted) return;
      connect();
      sendCommand({ type: "Speak", text });
    },

    flush(_options: TTSSpeakOptions): void {
      if (!ctx || ctx.signal.aborted) return;
      connect();
      sendCommand({ type: "Flush" });
    },

    clear(): void {
      if (!ctx || ctx.signal.aborted) return;
      isClearing = true;
      commandQueue = commandQueue.filter((command) => command.bypassClear);
      sendCommand({ type: "Clear" }, { bypassClear: true });
    },

    stop(): void {
      cleanup();
    },
  };
}
