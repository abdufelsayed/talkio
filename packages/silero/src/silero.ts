import { fileURLToPath } from "node:url";

import { InferenceSession, Tensor } from "onnxruntime-node";
import { createVAD, type VADContext, type VADProvider } from "talkio";

import { createAudioConverter } from "./audio";
import { createSegmenter } from "./segmenter";

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
const STATE_SIZE = 2 * 1 * 128;

export interface SileroOptions {
  /** Probability at which a frame counts as speech. @default 0.5 */
  threshold?: number;
  /** Speech shorter than this is ignored, such as clicks and taps. @default 64 */
  minSpeechMs?: number;
  /**
   * Silence that ends speech. Keep it short: the agent's turn-taking decides
   * how long a pause has to be before the user's turn ends. @default 300
   */
  minSilenceMs?: number;
  /** Path to a Silero VAD v5 ONNX model. Defaults to the one bundled with the package. */
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
  return fileURLToPath(new URL("../models/silero_vad.onnx", import.meta.url));
}

/**
 * Silero voice activity detection, run locally with ONNX Runtime.
 *
 * @example
 * ```typescript
 * import { silero } from "@talkio/silero";
 *
 * createAgent({ stt, llm, tts, vad: silero() });
 * ```
 */
export function silero(options: SileroOptions = {}): VADProvider {
  const threshold = options.threshold ?? 0.5;
  const modelPath = options.modelPath ?? defaultModelPath();
  let session: object | null = null;
  let run: ((audio: ArrayBuffer) => void) | null = null;

  return createVAD({
    name: "Silero",
    start(ctx: VADContext) {
      const current = {};
      session = current;
      run = null;
      const model = loadSession(modelPath);
      let state = new Float32Array(STATE_SIZE);
      let context = new Float32Array(CONTEXT_SAMPLES);
      let pending = new Float32Array(0);
      let queue = Promise.resolve();
      const segmenter = createSegmenter({
        threshold,
        minSpeechMs: options.minSpeechMs ?? 64,
        minSilenceMs: options.minSilenceMs ?? 300,
        frameMs: FRAME_MS,
      });
      const active = () => !ctx.signal.aborted && session === current;
      const fail = (error: unknown) => {
        if (active()) ctx.error(error instanceof Error ? error : new Error(String(error)));
      };

      let convert: (audio: ArrayBuffer) => Float32Array;
      try {
        convert = createAudioConverter(ctx.audioFormat, SAMPLE_RATE);
      } catch (error) {
        fail(error);
        return;
      }
      model.catch(fail);

      const infer = async (frame: Float32Array) => {
        const loaded = await model;
        if (!active()) return;
        const input = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
        input.set(context);
        input.set(frame, CONTEXT_SAMPLES);
        const result = await loaded.run({
          input: new Tensor("float32", input, [1, input.length]),
          state: new Tensor("float32", state, [2, 1, 128]),
          sr: new Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
        });
        if (!active()) return;
        state = Float32Array.from(result.stateN.data as Float32Array);
        context = frame.slice(FRAME_SAMPLES - CONTEXT_SAMPLES);
        const probability = (result.output.data as Float32Array)[0] ?? 0;
        ctx.probability(probability);
        const event = segmenter.push(probability);
        if (event?.type === "start") ctx.speechStart();
        else if (event?.type === "end") ctx.speechEnd(event.durationMs);
      };

      const analyze = (audio: ArrayBuffer) => {
        const samples = convert(audio);
        const joined = new Float32Array(pending.length + samples.length);
        joined.set(pending);
        joined.set(samples, pending.length);
        let offset = 0;
        for (; offset + FRAME_SAMPLES <= joined.length; offset += FRAME_SAMPLES) {
          const frame = joined.slice(offset, offset + FRAME_SAMPLES);
          queue = queue.then(() => infer(frame)).catch(fail);
        }
        pending = joined.slice(offset);
      };
      run = analyze;
    },
    stop() {
      session = null;
      run = null;
    },
    sendAudio(audio) {
      run?.(audio);
    },
  });
}
