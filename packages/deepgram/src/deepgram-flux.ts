/**
 * Deepgram Flux Speech-to-Text Provider
 *
 * Flux (`/v2/listen`) is conversational STT that decides when the user's turn
 * ends. The provider declares `turnDetection`, so the agent uses Flux's turn
 * events instead of final transcripts, and no separate turn detector is
 * needed:
 *
 * - `StartOfTurn` reports speech start, so Flux drives barge-in when no VAD
 *   provider is configured.
 * - `EagerEndOfTurn` and `TurnResumed` drive preemptive generation (enabled by
 *   `eagerEotThreshold`).
 * - `EndOfTurn` reports the final transcript and ends the turn.
 *
 * @see https://developers.deepgram.com/docs/flux/state
 * @module deepgram/deepgram-flux
 */

import type { STTContext, STTProvider } from "talkio";

import type {
  DeepgramFluxMessage,
  DeepgramFluxOptions,
  DeepgramFluxTurnInfo,
  DeepgramProviderSettings,
} from "./types";

const DEEPGRAM_FLUX_ENCODING_CONFIG = {
  linear16: { sampleRates: [8000, 16000, 24000, 44100, 48000], channels: [1] },
  linear32: { sampleRates: [8000, 16000, 24000, 44100, 48000], channels: [1] },
  mulaw: { sampleRates: [8000], channels: [1] },
  alaw: { sampleRates: [8000], channels: [1] },
  opus: { sampleRates: [8000, 16000, 24000, 48000], channels: [1] },
  "ogg-opus": { sampleRates: [8000, 16000, 24000, 48000], channels: [1] },
} as const;

export type DeepgramFluxEncoding = keyof typeof DEEPGRAM_FLUX_ENCODING_CONFIG;

/**
 * Input format type for Deepgram Flux. Flux transcribes a single channel.
 */
export type DeepgramFluxInputFormat = {
  [E in DeepgramFluxEncoding]: {
    encoding: E;
    sampleRate?: (typeof DEEPGRAM_FLUX_ENCODING_CONFIG)[E]["sampleRates"][number];
    channels?: 1;
  };
}[DeepgramFluxEncoding];

const SUPPORTED_INPUT_FORMATS: readonly DeepgramFluxInputFormat[] = Object.entries(
  DEEPGRAM_FLUX_ENCODING_CONFIG,
).flatMap(([encoding, config]) =>
  config.sampleRates.map(
    (sampleRate) => ({ encoding, sampleRate, channels: 1 }) as DeepgramFluxInputFormat,
  ),
);

const DEFAULT_INPUT_FORMAT: DeepgramFluxInputFormat = {
  encoding: "linear16",
  sampleRate: 16000,
  channels: 1,
};

const DEFAULT_MODEL = "flux-general-en";
const DEFAULT_BASE_URL = "api.deepgram.com";
const DEFAULT_EOT_THRESHOLD = 0.7;

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

function assertRange(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`Deepgram Flux ${name} must be between ${min} and ${max}, got ${value}`);
  }
}

function validateOptions(options: DeepgramFluxOptions, model: string): void {
  assertRange("eotThreshold", options.eotThreshold, 0.5, 1);
  assertRange("eagerEotThreshold", options.eagerEotThreshold, 0.3, 0.9);
  assertRange("eotTimeoutMs", options.eotTimeoutMs, 500, 60000);
  const eotThreshold = options.eotThreshold ?? DEFAULT_EOT_THRESHOLD;
  if (options.eagerEotThreshold !== undefined && options.eagerEotThreshold > eotThreshold) {
    throw new RangeError(
      `Deepgram Flux eagerEotThreshold (${options.eagerEotThreshold}) must not exceed eotThreshold (${eotThreshold})`,
    );
  }
  if ((options.languageHints?.length ?? 0) > 0 && model !== "flux-general-multi") {
    throw new Error("Deepgram Flux languageHints require the flux-general-multi model");
  }
}

/**
 * Create a Deepgram Flux STT provider with native turn detection.
 *
 * @example
 * ```typescript
 * import { createDeepgramFlux } from "@talkio/deepgram";
 *
 * const agent = createAgent({
 *   stt: createDeepgramFlux({ eagerEotThreshold: 0.5 }),
 *   llm,
 *   tts,
 * });
 * ```
 */
export function createDeepgramFlux(
  options: DeepgramFluxOptions = {},
  providerSettings: DeepgramProviderSettings = {},
): STTProvider<DeepgramFluxInputFormat> {
  const model = options.model ?? DEFAULT_MODEL;
  validateOptions(options, model);

  const baseUrl = options.baseUrl ?? providerSettings.baseUrl ?? DEFAULT_BASE_URL;
  const debug = options.debug ?? false;
  let ws: WebSocket | null = null;
  let ctx: STTContext | null = null;
  let audioBuffer: ArrayBuffer[] = [];
  let turnOpen = false;
  let reportedTranscript = "";

  function buildUrl(sampleRate: number, encoding: string): string {
    const params = new URLSearchParams();
    params.set("model", model);
    params.set("encoding", encoding);
    params.set("sample_rate", sampleRate.toString());
    if (options.eotThreshold !== undefined) {
      params.set("eot_threshold", options.eotThreshold.toString());
    }
    if (options.eagerEotThreshold !== undefined) {
      params.set("eager_eot_threshold", options.eagerEotThreshold.toString());
    }
    if (options.eotTimeoutMs !== undefined) {
      params.set("eot_timeout_ms", options.eotTimeoutMs.toString());
    }
    for (const keyterm of options.keyterms ?? []) params.append("keyterm", keyterm);
    for (const hint of options.languageHints ?? []) params.append("language_hint", hint);
    return `wss://${baseUrl}/v2/listen?${params.toString()}`;
  }

  function reportInterim(transcript: string): void {
    if (!transcript || transcript === reportedTranscript) return;
    reportedTranscript = transcript;
    ctx?.transcript(transcript, false);
  }

  function handleTurnInfo(message: DeepgramFluxTurnInfo): void {
    if (!ctx) return;
    const transcript = message.transcript.trim();

    switch (message.event) {
      case "StartOfTurn":
        turnOpen = true;
        ctx.speechStart();
        reportInterim(transcript);
        break;
      case "Update": {
        if (!turnOpen) break;
        reportInterim(transcript);
        const confidence = Number(message.end_of_turn_confidence);
        if (Number.isFinite(confidence)) ctx.turn.endOfTurnProbability(confidence);
        break;
      }
      case "EagerEndOfTurn":
        reportInterim(transcript);
        ctx.turn.eagerTurnEnd(transcript);
        break;
      case "TurnResumed":
        reportInterim(transcript);
        ctx.turn.turnResumed();
        break;
      case "EndOfTurn":
        turnOpen = false;
        reportedTranscript = "";
        if (transcript) ctx.transcript(transcript, true);
        ctx.speechEnd();
        ctx.turn.turnEnd(transcript);
        break;
    }
  }

  function handleMessage(event: MessageEvent): void {
    if (!ctx || typeof event.data !== "string") return;

    let message: DeepgramFluxMessage;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      ctx.error(
        error instanceof Error ? error : new Error("Failed to parse Deepgram Flux message"),
      );
      return;
    }

    switch (message.type) {
      case "TurnInfo":
        handleTurnInfo(message);
        break;
      case "Error":
        ctx.error(new Error(`Deepgram Flux error ${message.code}: ${message.description}`));
        break;
      case "Warning":
      case "ConfigureFailure":
        if (debug)
          console.warn(`[deepgram-flux] ${message.type}:`, message.code, message.description);
        break;
      case "Connected":
      case "ConfigureSuccess":
        if (debug) console.log(`[deepgram-flux] ${message.type}`);
        break;
    }
  }

  function flushBuffer(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const chunk of audioBuffer) ws.send(chunk);
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
    audioBuffer = [];
    turnOpen = false;
    reportedTranscript = "";
    ctx = null;
  }

  return {
    metadata: {
      name: "Deepgram Flux",
      version: "0.1.0",
      type: "stt",
      supportedInputFormats: SUPPORTED_INPUT_FORMATS,
      defaultInputFormat: DEFAULT_INPUT_FORMAT,
      turnDetection: true,
    },

    start(context: STTContext): void {
      if (context.signal.aborted) return;
      ctx = context;
      context.signal.addEventListener("abort", cleanup, { once: true });

      try {
        const apiKey = resolveApiKey(options.apiKey, providerSettings.apiKey);
        ws = new WebSocket(buildUrl(context.audioFormat.sampleRate, context.audioFormat.encoding), [
          "token",
          apiKey,
        ]);
        ws.addEventListener("open", flushBuffer);
        ws.addEventListener("message", handleMessage);
        ws.addEventListener("error", () => {
          ctx?.error(new Error("Deepgram Flux WebSocket error: Connection failed"));
        });
        ws.addEventListener("close", (event) => {
          audioBuffer = [];
          if (event.code !== 1000 && event.code !== 1005 && ctx) {
            ctx.error(
              new Error(`Deepgram Flux WebSocket closed: ${event.reason || `code ${event.code}`}`),
            );
          }
        });
      } catch (error) {
        ctx?.error(
          error instanceof Error ? error : new Error("Failed to connect to Deepgram Flux"),
        );
      }
    },

    stop(): void {
      cleanup();
    },

    sendAudio(audio: ArrayBuffer): void {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(audio);
      } else if (ws?.readyState === WebSocket.CONNECTING) {
        // Only a connecting socket will flush the buffer; a closed one never will.
        audioBuffer.push(audio);
      }
    },
  };
}
