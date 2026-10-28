import { fileURLToPath } from "node:url";

import { InferenceSession, Tensor } from "onnxruntime-node";
import type { TurnDetector } from "talkio";
import { createSampleConverter } from "talkio/audio";

import { whisperFeatures } from "./features";

const SAMPLE_RATE = 16000;
const WINDOW_SECONDS = 8;
const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS;
const MEL_BINS = 80;

export interface SmartTurnOptions {
  /** Path to a Smart Turn v3 ONNX model. Defaults to the one bundled with the package. */
  modelPath?: string;
}

const sessions = new Map<string, Promise<InferenceSession>>();

function loadSession(modelPath: string): Promise<InferenceSession> {
  let session = sessions.get(modelPath);
  if (!session) {
    session = InferenceSession.create(modelPath);
    session.catch(() => sessions.delete(modelPath));
    sessions.set(modelPath, session);
  }
  return session;
}

function defaultModelPath(): string {
  return fileURLToPath(new URL("../models/smart-turn-v3.2-cpu.onnx", import.meta.url));
}

/** The last eight seconds of input, oldest first, zero-padded at the start like the model's training data. */
function createAudioWindow() {
  const samples = new Float32Array(WINDOW_SAMPLES);
  let written = 0;
  return {
    push(chunk: Float32Array) {
      if (chunk.length >= WINDOW_SAMPLES) {
        samples.set(chunk.subarray(chunk.length - WINDOW_SAMPLES));
      } else {
        samples.copyWithin(0, chunk.length);
        samples.set(chunk, WINDOW_SAMPLES - chunk.length);
      }
      written += chunk.length;
    },
    get hasAudio() {
      return written > 0;
    },
    samples: () => samples.slice(),
  };
}

/**
 * Smart Turn v3, an audio end-of-turn model by Daily: it hears whether the
 * user sounds finished (intonation, pace, filler sounds) from the last eight
 * seconds of their voice, in any of 23 languages. Runs locally with ONNX
 * Runtime.
 *
 * @example
 * ```typescript
 * import { silero } from "@talkio/silero";
 * import { smartTurn } from "@talkio/smart-turn";
 *
 * createAgent({ stt, llm, tts, vad: silero(), turnDetector: smartTurn() });
 * ```
 */
export function smartTurn(options: SmartTurnOptions = {}): TurnDetector {
  const modelPath = options.modelPath ?? defaultModelPath();
  let model: Promise<InferenceSession> | null = null;
  let convert: ((chunk: ArrayBuffer) => Float32Array) | null = null;
  let window = createAudioWindow();

  return {
    name: "SmartTurn",
    output: "probability",
    async start(ctx) {
      window = createAudioWindow();
      convert = createSampleConverter(ctx.audioFormat, SAMPLE_RATE);
      model = loadSession(modelPath);
      await model;
    },
    stop() {
      convert = null;
    },
    sendAudio(audio) {
      if (convert) window.push(convert(audio));
    },
    async onPause({ signal }) {
      if (!model || !window.hasAudio || signal.aborted) return undefined;
      const features = whisperFeatures(window.samples());
      const session = await model;
      if (signal.aborted) return undefined;
      const result = await session.run({
        input_features: new Tensor("float32", features, [1, MEL_BINS, features.length / MEL_BINS]),
      });
      const output = result[session.outputNames[0] ?? "logits"];
      return (output?.data as Float32Array | undefined)?.[0];
    },
  };
}
