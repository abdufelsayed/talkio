/**
 * Deepgram Speech-to-Text Provider
 *
 * Implementation of the STT provider interface for Deepgram's streaming STT API.
 *
 * This module provides a fully-typed STT provider that connects to Deepgram's
 * WebSocket API for real-time speech transcription. It handles:
 * - WebSocket connection management and lifecycle
 * - Audio format configuration and validation
 * - Real-time transcript streaming (partial and final)
 * - VAD events (speech start/end) if enabled
 * - Error handling and reconnection
 * - Audio buffering before connection is ready
 *
 * **Supported Audio Formats**:
 * - `linear16` - 16-bit PCM at 8000, 16000, 24000, or 48000 Hz (default: 16000)
 * - `mulaw` - Mu-law encoding at 8000 Hz (telephony)
 * - `alaw` - A-law encoding at 8000 Hz (telephony)
 *
 * The provider is strongly typed with its supported input formats, enabling
 * compile-time validation when configuring audio in `createAgent()`.
 *
 * @module deepgram/deepgram-stt
 */

import type { STTContext, STTProvider } from "talkio";

import type { DeepgramProviderSettings, DeepgramSTTMessage, DeepgramSTTOptions } from "./types";

/**
 * Encoding configuration for Deepgram STT.
 *
 * Each encoding specifies its supported sample rates and channel counts.
 * PCM and compressed codecs support stereo, telephony/speech codecs are mono-only.
 */
const DEEPGRAM_STT_ENCODING_CONFIG = {
  linear16: { sampleRates: [8000, 16000, 24000, 48000], channels: [1, 2] },
  linear32: { sampleRates: [16000, 24000, 48000], channels: [1, 2] },
  flac: { sampleRates: [16000, 24000, 48000], channels: [1, 2] },
  mulaw: { sampleRates: [8000], channels: [1] },
  alaw: { sampleRates: [8000], channels: [1] },
  "amr-nb": { sampleRates: [8000], channels: [1] },
  "amr-wb": { sampleRates: [16000], channels: [1] },
  opus: { sampleRates: [8000, 16000, 24000, 48000], channels: [1, 2] },
  "ogg-opus": { sampleRates: [8000, 16000, 24000, 48000], channels: [1, 2] },
  speex: { sampleRates: [8000, 16000, 32000], channels: [1] },
  g729: { sampleRates: [8000], channels: [1] },
} as const;

/**
 * Supported encoding types for Deepgram STT.
 */
export type DeepgramSTTEncoding = keyof typeof DEEPGRAM_STT_ENCODING_CONFIG;

/**
 * Input format type for Deepgram STT with per-encoding type narrowing.
 *
 * Each encoding constrains both sampleRate and channels to valid values.
 * For example, `linear16` supports stereo while `mulaw` is mono-only.
 */
export type DeepgramSTTInputFormat = {
  [E in DeepgramSTTEncoding]: {
    encoding: E;
    sampleRate?: (typeof DEEPGRAM_STT_ENCODING_CONFIG)[E]["sampleRates"][number];
    channels?: (typeof DEEPGRAM_STT_ENCODING_CONFIG)[E]["channels"][number];
  };
}[DeepgramSTTEncoding];

function generateSupportedFormats(): readonly DeepgramSTTInputFormat[] {
  const formats: DeepgramSTTInputFormat[] = [];
  for (const [encoding, config] of Object.entries(DEEPGRAM_STT_ENCODING_CONFIG)) {
    for (const sampleRate of config.sampleRates) {
      for (const channels of config.channels) {
        formats.push({
          encoding,
          sampleRate,
          channels,
        } as DeepgramSTTInputFormat);
      }
    }
  }
  return formats;
}

const SUPPORTED_INPUT_FORMATS = generateSupportedFormats();

const DEFAULT_INPUT_FORMAT: DeepgramSTTInputFormat = {
  encoding: "linear16",
  sampleRate: 16000,
  channels: 1,
};

const DEFAULT_LANGUAGE = "en";
const DEFAULT_BASE_URL = "api.deepgram.com";

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
 * Create a Deepgram STT provider for streaming speech-to-text.
 *
 * This provider connects to Deepgram's streaming WebSocket API for real-time
 * speech transcription. It supports a comprehensive set of audio encodings and
 * provides both partial (interim) and final transcripts.
 *
 * **Supported audio encodings and sample rates**:
 * - **PCM**: `linear16` (8000, 16000, 24000, 48000 Hz), `linear32` (16000, 24000, 48000 Hz)
 * - **Compressed**: `flac` (16000, 24000, 48000 Hz), `opus` (8000, 16000, 24000, 48000 Hz), `ogg-opus` (8000, 16000, 24000, 48000 Hz)
 * - **Speech codecs**: `speex` (8000, 16000, 32000 Hz), `amr-nb` (8000 Hz), `amr-wb` (16000 Hz), `g729` (8000 Hz)
 * - **Telephony**: `mulaw` (8000 Hz), `alaw` (8000 Hz)
 *
 * When using raw audio, you must specify the encoding and sample_rate.
 * For containerized audio (WAV, Ogg), Deepgram reads the header automatically.
 *
 * The provider automatically handles:
 * - WebSocket connection management
 * - Audio buffering before connection is ready
 * - VAD events (speech start/end) if enabled
 * - Error handling and reconnection
 *
 * @param options - STT configuration options (model, language, API key, etc.)
 * @param providerSettings - Optional provider-level settings (API key, base URL)
 *   These are used as fallbacks if not specified in options.
 * @returns A typed STT provider that can be used in createAgent
 *
 * @see https://developers.deepgram.com/docs/encoding
 * @see https://developers.deepgram.com/docs/models
 *
 * @example Basic usage
 * ```typescript
 * import { createDeepgramSTT } from "@talkio/deepgram";
 *
 * const stt = createDeepgramSTT({
 *   apiKey: process.env.DEEPGRAM_API_KEY,
 *   model: "nova-3",
 *   language: "en",
 * });
 * ```
 *
 * @example With advanced options
 * ```typescript
 * const stt = createDeepgramSTT({
 *   apiKey: process.env.DEEPGRAM_API_KEY,
 *   model: "nova-2",
 *   language: "en",
 *   interimResults: true,
 *   punctuate: true,
 *   smartFormat: true,
 *   endpointing: 300,
 *   keywords: ["voice-ai", "Deepgram"],
 *   vad: true,
 * });
 * ```
 */
export function createDeepgramSTT(
  options: DeepgramSTTOptions,
  providerSettings: DeepgramProviderSettings = {},
): STTProvider<DeepgramSTTInputFormat> {
  const {
    model,
    language = DEFAULT_LANGUAGE,
    interimResults = true,
    punctuate = true,
    smartFormat = true,
    endpointing = 300,
    utteranceEndMs = 1000,
    keywords = [],
    vad = true,
  } = options;

  const baseUrl = options.baseUrl ?? providerSettings.baseUrl ?? DEFAULT_BASE_URL;

  const debug = options.debug ?? false;
  let ws: WebSocket | null = null;
  let ctx: STTContext | null = null;
  let isConnected = false;
  let audioBuffer: ArrayBuffer[] = [];
  let audioChunksSent = 0;

  function buildUrl(sampleRate: number, channels: number, encoding: DeepgramSTTEncoding): string {
    const params = new URLSearchParams();

    params.set("model", model);
    params.set("language", language);
    params.set("encoding", encoding);
    params.set("sample_rate", sampleRate.toString());
    params.set("channels", channels.toString());
    params.set("punctuate", punctuate.toString());
    params.set("smart_format", smartFormat.toString());
    params.set("interim_results", interimResults.toString());

    if (endpointing !== false) {
      params.set("endpointing", endpointing.toString());
    }

    params.set("utterance_end_ms", utteranceEndMs.toString());

    if (vad) {
      params.set("vad_events", "true");
    }

    if (keywords.length > 0) {
      for (const keyword of keywords) {
        params.append("keywords", keyword);
      }
    }

    return `wss://${baseUrl}/v1/listen?${params.toString()}`;
  }

  function handleMessage(event: MessageEvent): void {
    if (!ctx) return;

    try {
      const message: DeepgramSTTMessage = JSON.parse(event.data as string);

      if (debug && message.type !== "Results") {
        console.log("[deepgram-stt] Received:", message.type);
      }

      switch (message.type) {
        case "Results": {
          const transcript = message.channel.alternatives[0]?.transcript ?? "";
          if (debug && transcript) {
            console.log("[deepgram-stt] Transcript:", transcript, "final:", message.is_final);
          }
          if (transcript) {
            ctx.transcript(transcript, message.is_final);
          }
          break;
        }

        case "SpeechStarted": {
          if (debug) console.log("[deepgram-stt] Speech started");
          ctx.speechStart();
          break;
        }

        case "UtteranceEnd": {
          if (debug) console.log("[deepgram-stt] Utterance end");
          ctx.speechEnd();
          break;
        }

        case "Error": {
          if (debug) console.error("[deepgram-stt] Error:", message.description);
          ctx.error(new Error(`Deepgram STT error: ${message.description}`));
          break;
        }

        case "Metadata": {
          if (debug) console.log("[deepgram-stt] Metadata received");
          break;
        }
      }
    } catch (error) {
      if (debug) console.error("[deepgram-stt] Parse error:", error);
      ctx?.error(error instanceof Error ? error : new Error("Failed to parse Deepgram message"));
    }
  }

  function flushBuffer(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    for (const chunk of audioBuffer) {
      ws.send(chunk);
    }
    audioBuffer = [];
  }

  function cleanup(): void {
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      ws.close();
      ws = null;
    }
    isConnected = false;
    audioBuffer = [];
    ctx = null;
  }

  return {
    metadata: {
      name: "Deepgram",
      version: "0.1.0",
      type: "stt",
      supportedInputFormats: SUPPORTED_INPUT_FORMATS,
      defaultInputFormat: DEFAULT_INPUT_FORMAT,
    },

    start(context: STTContext): void {
      ctx = context;
      const apiKey = resolveApiKey(options.apiKey, providerSettings.apiKey);
      const url = buildUrl(
        context.audioFormat.sampleRate,
        context.audioFormat.channels,
        context.audioFormat.encoding as DeepgramSTTEncoding,
      );

      if (context.signal.aborted) {
        return;
      }

      context.signal.addEventListener("abort", cleanup);

      try {
        if (debug)
          console.log("[deepgram-stt] Connecting to:", url.replace(/token=[^&]+/, "token=***"));
        ws = new WebSocket(url, ["token", apiKey]);

        ws.addEventListener("open", () => {
          isConnected = true;
          if (debug)
            console.log(
              "[deepgram-stt] WebSocket connected, flushing",
              audioBuffer.length,
              "buffered chunks",
            );
          flushBuffer();
        });

        ws.addEventListener("message", handleMessage);

        ws.addEventListener("error", () => {
          if (debug) console.error("[deepgram-stt] WebSocket error: Connection failed");
          ctx?.error(new Error("Deepgram WebSocket error: Connection failed"));
        });

        ws.addEventListener("close", (event) => {
          isConnected = false;
          if (debug) console.log("[deepgram-stt] WebSocket closed:", event.code, event.reason);
          if (event.code !== 1000 && event.code !== 1005 && ctx) {
            ctx.error(
              new Error(`Deepgram WebSocket closed: ${event.reason || `code ${event.code}`}`),
            );
          }
        });
      } catch (error) {
        if (debug) console.error("[deepgram-stt] Failed to connect:", error);
        ctx?.error(error instanceof Error ? error : new Error("Failed to connect to Deepgram"));
      }
    },

    stop(): void {
      cleanup();
    },

    sendAudio(audio: ArrayBuffer): void {
      audioChunksSent++;
      if (debug && audioChunksSent % 100 === 1) {
        console.log(
          "[deepgram-stt] Audio chunks sent:",
          audioChunksSent,
          "connected:",
          isConnected,
          "wsState:",
          ws?.readyState,
        );
      }
      if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(audio);
      } else {
        audioBuffer.push(audio);
      }
    },
  };
}
