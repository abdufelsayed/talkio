/**
 * Agent State Machine
 *
 * Orchestrates a voice conversation as parallel regions:
 *
 * - `input`: the user's voice activity, from the VAD provider when one is
 *   configured and from the STT provider otherwise.
 * - `human`: the user's turn. Opens on speech, accumulates transcripts, and
 *   commits when the turn source says the user is done: a final transcript, a
 *   `turnEnd` from a turn detector or the STT, or a predicted end of turn.
 * - `ai`: the agent's turn. Generates with the LLM, speaks through TTS, and
 *   yields when the user overlaps it. It can prepare a reply speculatively
 *   before the turn commits. While an interruption is pending the agent's
 *   audio is held, so a false alarm resumes exactly where it stopped.
 *
 * While the agent is responding it owns overlapping user speech and decides
 * whether it is an interruption; once it yields, the human region takes over.
 * Two more regions handle the edges of a conversation: `silence` prompts the
 * user when both sides have been quiet for `silence.timeoutMs`, and
 * `backchannel` speaks short acknowledgements while the user talks at length.
 *
 * Regions coordinate through raised internal events such as `_human:committed`.
 *
 * @module agent/machine
 */

import { nanoid } from "nanoid";
import { and, enqueueActions, not, setup } from "xstate";

import { audioDurationMs, audioSampleCount, bytesPerFrame } from "../audio/duration";
import type { AgentMachineOutput, Message } from "../types/common";
import type {
  InterruptionClassifierInput,
  InterruptionVerdict,
  NormalizedAgentConfig,
} from "../types/config";
import type {
  AITurnAudioEvent,
  HumanTurnAbandonedEvent,
  InternalAudioOutputChunkEvent,
  InterruptionCancelReason,
  MachineEvent,
  PublicAgentEvent,
} from "../types/events";
import {
  audioStreamerActor,
  llmActor,
  sttActor,
  ttsActor,
  turnDetectorActor,
  vadActor,
} from "./actors";
import type { AudioOutputBuffer } from "./audio-output";
import {
  createInitialContext,
  type AgentMachineContext,
  type AITurn,
  type HeldChunk,
  type HumanTurn,
  type Overlap,
} from "./context";
import { buildAITurnMetrics, buildHumanTurnMetrics } from "./helpers";
import { appendAssistantMessage, appendUserMessage } from "./history";
import * as metrics from "./metrics";
import { classifyInterruption, isEcho, transcriptWords } from "./overlap";
import {
  heardText,
  pausePlayback,
  PLAYOUT_EPSILON_MS,
  playbackPosition,
  releaseAudio,
  remainingPlayoutMs,
  reportPlayback,
  resumePlayback,
} from "./playback";
import { splitAllSentences } from "./segmenter";
import * as speech from "./speech";
import { getConfigNow } from "./time";
import { trace } from "./trace";
import { endOfTurnDelayMs } from "./turn-taking";

const DEFAULT_SILENCE_TIMEOUT_MS = 5000;
const DEFAULT_SILENCE_PROMPT = "Are you still there?";
const DEFAULT_SILENCE_MAX_PROMPTS = 3;

/** How long a human turn with no transcript at all may stay open after speech ends. */
const NO_TRANSCRIPT_ABANDON_MS = 2000;

/** How long to wait for a final transcript after speech ends before using the interim one. */
const MISSING_FINAL_COMMIT_MS = 4000;

type Context = AgentMachineContext;
type TraceInput = Parameters<typeof trace>[1];

function now(context: Context): number {
  return getConfigNow(context.config);
}

function humanTranscript(said: Pick<HumanTurn, "finalText" | "interimText">): string {
  return [said.finalText, said.interimText].filter(Boolean).join(" ").trim();
}

function startOverlap(startedAt: number): Overlap {
  return { startedAt, finalText: "", interimText: "", turnEnded: false, verdict: null };
}

/** Same words, ignoring case and punctuation, which finals add to interim text. */
function sameTranscript(a: string, b: string): boolean {
  return transcriptWords(a).join(" ") === transcriptWords(b).join(" ");
}

function eagerTranscript(context: Context, event: MachineEvent): string {
  if (event.type !== "_turn:eager-end") return "";
  return event.transcript.trim() || (context.human ? humanTranscript(context.human) : "");
}

type SnapshotSource = { getSnapshot(): { context: AgentMachineContext } };

function llmInput(context: Context, ai: AITurn, messages: Message[], self: SnapshotSource) {
  return {
    config: context.config,
    messages,
    abortSignal: ai.abortController.signal,
    turnId: ai.id,
    generationId: ai.generationId,
    isSpeaking: () => self.getSnapshot().context.isSpeaking,
    isSpeculative: () => {
      const current = self.getSnapshot().context.ai;
      return current?.generationId === ai.generationId && current.speculative;
    },
    commitment: ai.commitment.promise,
  };
}

function overlapElapsedMs(context: Context): number {
  const startedAt = context.ai?.overlap?.startedAt;
  return startedAt === undefined ? 0 : now(context) - startedAt;
}

/** The public, stream, and trace events that send chunks to the listener. */
function audioEvents(ai: AITurn, chunks: readonly HeldChunk[], timestamp: number) {
  const emitted: AITurnAudioEvent[] = [];
  const streamed: InternalAudioOutputChunkEvent[] = [];
  const traces: TraceInput[] = [];
  for (const chunk of chunks) {
    traces.push({
      type: "ai-turn:audio",
      turnId: ai.id,
      requestId: chunk.requestId,
      data: { bytes: chunk.audio.byteLength },
    });
    emitted.push({
      type: "ai-turn:audio",
      turnId: ai.id,
      requestId: chunk.requestId,
      audio: chunk.audio,
      timestamp,
    });
    streamed.push({
      type: "_audio:output-chunk",
      audio: chunk.audio,
      turnId: ai.id,
      requestId: chunk.requestId,
      timestamp,
    });
  }
  return { emitted, streamed, traces };
}

/** Releases new audio to the listener: timeline, playback estimate, metrics, and events. */
function deliverChunks(context: Context, ai: AITurn, chunks: readonly HeldChunk[]) {
  const timestamp = now(context);
  const format = context.config.audio.output;
  const retain = context.config.interruption.pendingAudio === "clear";
  let delivered = ai;
  let tracked = context.metrics;

  for (const chunk of chunks) {
    const samples = audioSampleCount(chunk.audio.byteLength, format) ?? 0;
    delivered = speech.recordChunk(delivered, chunk);
    tracked = metrics.recordAudioChunk(tracked, timestamp, samples);

    const durationMs = audioDurationMs(chunk.audio.byteLength, format);
    if (delivered.playback && durationMs !== null) {
      const startMs = delivered.playback.releasedMs;
      delivered = {
        ...speech.placeOnTimeline(delivered, chunk.requestId, startMs, durationMs),
        playback: releaseAudio(
          delivered.playback,
          timestamp,
          durationMs,
          context.config.playback.outputLatencyMs,
        ),
        released: retain
          ? [...delivered.released, { ...chunk, startMs, durationMs }]
          : delivered.released,
      };
    }
  }

  return { ai: delivered, metrics: tracked, ...audioEvents(ai, chunks, timestamp) };
}

/** Released audio from `fromMs` on, for a listener that dropped its buffer. */
function replayChunks(context: Context, ai: AITurn, fromMs: number): HeldChunk[] {
  const frameBytes = bytesPerFrame(context.config.audio.output) ?? 1;
  return ai.released.flatMap((chunk) => {
    if (chunk.startMs + chunk.durationMs <= fromMs) return [];
    if (chunk.startMs >= fromMs || chunk.durationMs === 0) {
      return [{ requestId: chunk.requestId, audio: chunk.audio }];
    }
    const fraction = (fromMs - chunk.startMs) / chunk.durationMs;
    const offset = Math.floor((fraction * chunk.audio.byteLength) / frameBytes) * frameBytes;
    return [{ requestId: chunk.requestId, audio: chunk.audio.slice(offset) }];
  });
}

function tracksPlayback(context: Context): boolean {
  return bytesPerFrame(context.config.audio.output) !== null;
}

function humanTurnAbandonment(context: Context, human: HumanTurn, reason: string) {
  const event: HumanTurnAbandonedEvent = {
    type: "human-turn:abandoned",
    turnId: human.id,
    reason,
    timestamp: now(context),
  };
  return {
    event,
    update: {
      human: null,
      partialTranscript: "",
      metrics: metrics.recordHumanTurnAbandoned(context.metrics),
    },
  };
}

const agentMachineSetup = setup({
  types: {
    context: {} as AgentMachineContext,
    events: {} as MachineEvent,
    input: {} as { config: NormalizedAgentConfig; audioOutput: AudioOutputBuffer },
    output: {} as AgentMachineOutput,
    emitted: {} as PublicAgentEvent,
  },

  actors: {
    stt: sttActor,
    vad: vadActor,
    turnDetector: turnDetectorActor,
    llm: llmActor,
    tts: ttsActor,
    audioStreamer: audioStreamerActor,
  },

  delays: {
    speculativeCutoff: ({ context }) => context.config.interruption.speculativeCutoffMs,
    resumeAfter: ({ context }) => context.config.interruption.resumeAfterMs,
    maxPending: ({ context }) => context.config.interruption.maxPendingMs,
    silenceTimeout: ({ context }) =>
      context.config.silence?.timeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS,
    fillerDelay: ({ context }) => context.config.fillers.afterMs,
    backchannelPause: ({ context }) => {
      const quietSince = context.human?.quietSince ?? now(context);
      return Math.max(0, context.config.backchannels.pauseMs - (now(context) - quietSince));
    },
    playoutRemaining: ({ context }) =>
      context.ai?.playback ? Math.ceil(remainingPlayoutMs(context.ai.playback, now(context))) : 0,
    humanTurnTimeout: ({ context }) => {
      const human = context.human;
      if (!human || !humanTranscript(human)) return NO_TRANSCRIPT_ABANDON_MS;
      if (context.turnSource !== "prediction") return MISSING_FINAL_COMMIT_MS;
      const quietSince = human.quietSince ?? now(context);
      const delay = endOfTurnDelayMs(human.endOfTurnProbability, context.config.turnTaking);
      return Math.max(0, quietSince + delay - now(context));
    },
  },

  guards: {
    interruptionEnabled: ({ context }) => context.config.interruption.enabled,
    fillerDue: ({ context }) =>
      context.config.fillers.enabled &&
      context.ai !== null &&
      context.ai.segments.length === 0 &&
      context.ai.queue.length === 0,
    backchannelDue: ({ context }) => {
      const { enabled, minSpeechMs, maxEndOfTurnProbability } = context.config.backchannels;
      const human = context.human;
      // The TTS session speaks one request at a time, so a reply, even a speculative
      // one, rules out a backchannel.
      if (!enabled || !human || context.ai !== null) return false;
      if (human.endOfTurnProbability === null) return false;
      return (
        human.endOfTurnProbability <= maxEndOfTurnProbability &&
        human.speechSinceBackchannelMs >= minSpeechMs
      );
    },
    isBackchannelSpeech: ({ context, event }) =>
      (event.type === "_tts:chunk" ||
        event.type === "_tts:complete" ||
        event.type === "_tts:error") &&
      event.requestId === context.backchannel?.requestId,
    canSpeakScripted: ({ context }) =>
      context.pendingSay.length > 0 &&
      context.human === null &&
      context.ai === null &&
      !context.userTurnCommitting,
    silenceWatchActive: ({ context }) => {
      const silence = context.config.silence;
      if (!silence?.enabled) return false;
      if (context.ai !== null || context.human !== null || context.voice.active) return false;
      if (context.pendingSay.length > 0 || context.userTurnCommitting) return false;
      if ((silence.startMode ?? "afterFirstSpeech") === "afterFirstSpeech" && !context.heardUser) {
        return false;
      }
      return context.silencePrompts < (silence.maxPrompts ?? DEFAULT_SILENCE_MAX_PROMPTS);
    },
    interruptsImmediately: ({ context }) =>
      context.config.interruption.enabled && context.config.interruption.minDurationMs === 0,
    cutoffIsImmediate: ({ context }) => context.config.interruption.speculativeCutoffMs === 0,
    humanMayStart: ({ context }) =>
      context.ai === null || context.ai.speculative || !context.config.interruption.enabled,
    voiceActive: ({ context }) => context.voice.active,
    hasTranscriptText: ({ event }) =>
      event.type === "_stt:transcript" && event.text.trim().length > 0,
    turnEndHasTranscript: ({ event }) =>
      event.type === "_turn:end" && event.transcript.trim().length > 0,
    sttEndsTurn: ({ context, event }) =>
      context.turnSource === "stt" && event.type === "_stt:transcript" && event.isFinal,
    humanHasTranscript: ({ context }) =>
      context.human !== null && humanTranscript(context.human).length > 0,
    agentEndsTurn: ({ context }) =>
      context.turnSource === "stt" || context.turnSource === "prediction",
    preemptiveGenerationEnabled: ({ context }) => context.config.turnTaking.preemptiveGeneration,
    eagerTranscriptPresent: ({ context, event }) => eagerTranscript(context, event).length > 0,
    isNewSpeculativeTranscript: ({ context, event }) =>
      context.ai !== null &&
      !sameTranscript(eagerTranscript(context, event), context.ai.inputTranscript),
    matchesSpeculativeTranscript: ({ context, event }) =>
      event.type === "_human:committed" &&
      context.ai !== null &&
      sameTranscript(event.transcript, context.ai.inputTranscript),
    predictionTurnSource: ({ context }) => context.turnSource === "prediction",
    predictedEndOfTurnDue: ({ context, event }) => {
      const human = context.human;
      if (event.type !== "_turn:prediction" || context.turnSource !== "prediction") return false;
      if (!human || !humanTranscript(human) || human.quietSince === null) return false;
      const delay = endOfTurnDelayMs(event.probability, context.config.turnTaking);
      return human.quietSince + delay <= now(context);
    },
    beginCommits: ({ event }) => event.type === "_human:begin" && event.commit,

    isCurrentGeneration: ({ context, event }) =>
      "generationId" in event && event.generationId === context.ai?.generationId,
    isActiveSpeech: ({ context, event }) =>
      (event.type === "_tts:chunk" ||
        event.type === "_tts:words" ||
        event.type === "_tts:complete" ||
        event.type === "_tts:error") &&
      event.requestId === context.ai?.active?.requestId,
    aiTurnComplete: ({ context }) =>
      context.ai !== null && context.ai.llmCompleted && speech.isSpeechIdle(context.ai),
    playoutDone: ({ context }) => {
      const playback = context.ai?.playback;
      return !playback || remainingPlayoutMs(playback, now(context)) < PLAYOUT_EPSILON_MS;
    },

    voiceHoldsFloor: ({ context }) => context.ai !== null && !context.ai.echoSuspected,
    isCurrentTurnVerdict: ({ context, event }) =>
      event.type === "_overlap:verdict" && event.turnId === context.ai?.id,
    overlapInterrupts: ({ context, event }) =>
      event.type === "_overlap:verdict" &&
      event.turnId === context.ai?.id &&
      event.verdict === "interrupt",
    overlapAcknowledged: ({ context, event }) =>
      event.type === "_overlap:verdict" &&
      event.turnId === context.ai?.id &&
      (event.verdict === "backchannel" || event.verdict === "echo"),
    lastVerdictAcknowledged: ({ context }) => {
      const verdict = context.ai?.overlap?.verdict;
      return verdict === "backchannel" || verdict === "echo";
    },
    overlapTooShort: ({ context }) =>
      overlapElapsedMs(context) < context.config.interruption.minDurationMs,
  },

  actions: {
    startSession: enqueueActions(({ context, enqueue }) => {
      enqueue.assign({ metrics: metrics.recordSessionStart(context.metrics, now(context)) });
      enqueue(() => trace(context.config, { type: "agent:started" }));
      enqueue.emit({ type: "agent:started", timestamp: now(context) });
    }),

    stopSession: enqueueActions(({ context, enqueue }) => {
      enqueue(() => {
        context.ai?.commitment.settle(false);
        context.ai?.abortController.abort();
        context.sessionAbortController.abort();
        context.audioOutput.close();
        trace(context.config, { type: "agent:stopped" });
      });
      enqueue.emit({ type: "agent:stopped", timestamp: now(context) });
    }),

    reportProviderError: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_stt:error" && event.type !== "_vad:error") return;
      const source = event.type === "_stt:error" ? "stt" : "vad";
      enqueue.assign({ metrics: metrics.recordError(context.metrics, source) });
      enqueue.emit({ type: "agent:error", error: event.error, source, timestamp: now(context) });
    }),

    forwardAudioInput: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_audio:input") return;
      enqueue(() =>
        trace(context.config, { type: "audio:input", data: { bytes: event.audio.byteLength } }),
      );
      enqueue.sendTo("stt", event);
      enqueue.sendTo("vad", event);
      enqueue.sendTo("turnDetector", event);
    }),

    forwardToTurnDetector: enqueueActions(({ event, enqueue }) => {
      enqueue.sendTo("turnDetector", event);
    }),

    emitVADProbability: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_vad:probability") return;
      enqueue.emit({ type: "vad:probability", value: event.value, timestamp: now(context) });
    }),

    recordVoiceStart: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_voice:start") return;
      enqueue.assign({ voice: { active: true, startedAt: event.timestamp } });
      enqueue(() =>
        trace(context.config, {
          type: "speech:start",
          turnId: context.ai?.id,
          data: {
            source: event.source,
            speaking: context.isSpeaking,
            audioStarted: context.ai?.audioDelivered ?? false,
          },
        }),
      );
    }),

    recordVoiceEnd: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_voice:end") return;
      enqueue.assign({
        voice: { active: false, startedAt: null },
        human: context.human
          ? {
              ...context.human,
              speechMs: context.human.speechMs + event.durationMs,
              speechSinceBackchannelMs: context.human.speechSinceBackchannelMs + event.durationMs,
              quietSince: event.timestamp,
            }
          : null,
      });
      enqueue(() =>
        trace(context.config, {
          type: "speech:end",
          turnId: context.ai?.id,
          data: {
            source: event.source,
            speaking: context.isSpeaking,
            audioStarted: context.ai?.audioDelivered ?? false,
            duration: event.durationMs,
          },
        }),
      );
    }),

    openHumanTurn: enqueueActions(({ context, enqueue }) => {
      if (context.human) return;
      const human: HumanTurn = {
        id: nanoid(),
        startedAt: now(context),
        finalText: "",
        interimText: "",
        speechMs: 0,
        speechSinceBackchannelMs: 0,
        quietSince: null,
        endOfTurnProbability: null,
      };
      enqueue.assign({
        human,
        heardUser: true,
        silencePrompts: 0,
        metrics: metrics.recordHumanTurnStart(context.metrics, human.startedAt),
      });
      enqueue(() => trace(context.config, { type: "human-turn:started", turnId: human.id }));
      enqueue.emit({ type: "human-turn:started", turnId: human.id, timestamp: human.startedAt });
    }),

    recordHumanTranscript: enqueueActions(({ context, event, enqueue }) => {
      const human = context.human;
      if (!human) return;
      const updates =
        event.type === "_stt:transcript"
          ? [{ text: event.text, isFinal: event.isFinal }]
          : event.type === "_human:begin"
            ? [
                { text: event.finalText, isFinal: true },
                { text: event.interimText, isFinal: false },
              ]
            : [];
      let updated = human;
      let partialTranscript = context.partialTranscript;
      for (const { text, isFinal } of updates) {
        if (!text.trim()) continue;
        const quietSince = context.voice.active ? updated.quietSince : now(context);
        updated = isFinal
          ? {
              ...updated,
              finalText: [updated.finalText, text.trim()].filter(Boolean).join(" "),
              interimText: "",
              quietSince,
            }
          : { ...updated, interimText: text.trim(), quietSince };
        partialTranscript = isFinal ? "" : text;
        enqueue.emit({
          type: "human-turn:transcript",
          turnId: human.id,
          text,
          isFinal,
          timestamp: now(context),
        });
      }
      enqueue.assign({ human: updated, partialTranscript });
    }),

    commitHumanTurn: enqueueActions(({ context, event, enqueue }) => {
      const human = context.human;
      if (!human) return;
      const transcript =
        (event.type === "_turn:end" && event.transcript.trim()) || humanTranscript(human);

      // A user turn can only overlap an audible reply when interruptions are off;
      // then the microphone hearing the agent must not become a question for it.
      const ai = context.ai;
      const echo = ai !== null && isEcho(transcript, speech.spokenText(ai).started);
      if (!transcript || echo) {
        const abandoned = humanTurnAbandonment(context, human, echo ? "echo" : "empty-transcript");
        enqueue.emit(abandoned.event);
        enqueue.assign(abandoned.update);
        return;
      }

      const timestamp = now(context);
      const speechMs = human.speechMs || timestamp - human.startedAt;
      const turnMetrics = metrics.recordHumanTurnEnd(
        context.metrics,
        timestamp,
        speechMs,
        transcript.length,
      );
      enqueue(() =>
        trace(context.config, {
          type: "human-turn:ended",
          turnId: human.id,
          data: { length: transcript.length, preview: transcript.slice(0, 120) },
        }),
      );
      enqueue.emit({
        type: "human-turn:ended",
        turnId: human.id,
        transcript,
        metrics: buildHumanTurnMetrics(turnMetrics),
        timestamp,
      });
      enqueue.assign({
        human: null,
        partialTranscript: "",
        userTurnCommitting: true,
        metrics: metrics.finishHumanTurn(turnMetrics),
      });
      enqueue.raise({ type: "_human:committed", transcript, timestamp });
    }),

    abandonHumanTurn: enqueueActions(
      ({ context, event, enqueue }, params: { reason?: string } | undefined) => {
        const human = context.human;
        if (!human) return;
        const reason =
          params?.reason ?? (event.type === "_turn:abandoned" ? event.reason : "no-transcript");
        const abandoned = humanTurnAbandonment(context, human, reason);
        enqueue.emit(abandoned.event);
        enqueue.assign(abandoned.update);
      },
    ),

    recordEndOfTurnProbability: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_turn:prediction") return;
      enqueue(() =>
        trace(context.config, {
          type: "turn:prediction",
          turnId: context.human?.id,
          data: { probability: event.probability },
        }),
      );
      if (!context.human) return;
      enqueue.assign({ human: { ...context.human, endOfTurnProbability: event.probability } });
    }),

    maybeEagerEndOfTurn: enqueueActions(({ context, enqueue }) => {
      const human = context.human;
      const { preemptiveGeneration, eagerEndOfTurnThreshold } = context.config.turnTaking;
      if (!human || context.turnSource !== "prediction" || !preemptiveGeneration) return;
      if (context.voice.active || human.endOfTurnProbability === null) return;
      if (human.endOfTurnProbability < eagerEndOfTurnThreshold) return;
      const transcript = humanTranscript(human);
      if (!transcript) return;
      enqueue.raise({ type: "_turn:eager-end", transcript, timestamp: now(context) });
    }),

    beginHumanTurnFromOverlap: enqueueActions(({ context, enqueue }) => {
      const overlap = context.ai?.overlap ?? startOverlap(now(context));
      // Only the turn source ends the user's turn: a final transcript when STT
      // decides, otherwise a turnEnd, even one that came before the verdict did.
      const commit =
        overlap.turnEnded ||
        (context.turnSource === "stt" && overlap.finalText !== "" && overlap.interimText === "");
      enqueue.raise({
        type: "_human:begin",
        finalText: overlap.finalText,
        interimText: overlap.interimText,
        commit,
        timestamp: now(context),
      });
    }),

    classifyOverlapEvidence: enqueueActions(({ context, event, enqueue, self }) => {
      const ai = context.ai;
      if (!ai) return;
      const overlap = ai.overlap ?? startOverlap(now(context));
      let transcript: string;
      let isFinal: boolean;
      let evidence: Overlap;
      if (event.type === "_stt:transcript") {
        transcript = event.text.trim();
        isFinal = event.isFinal;
        // Once the turn source ended the turn with words, later transcripts repeat them.
        const settled = overlap.turnEnded && humanTranscript(overlap) !== "";
        evidence = settled
          ? overlap
          : isFinal
            ? {
                ...overlap,
                finalText: [overlap.finalText, transcript].filter(Boolean).join(" "),
                interimText: "",
              }
            : { ...overlap, interimText: transcript };
      } else if (event.type === "_turn:end") {
        transcript = event.transcript.trim() || humanTranscript(overlap);
        isFinal = true;
        evidence = { ...overlap, finalText: transcript, interimText: "", turnEnded: true };
      } else {
        return;
      }
      enqueue.assign({ ai: { ...ai, overlap: evidence } });
      if (!transcript) return;

      const input: InterruptionClassifierInput = {
        transcript,
        isFinal,
        agentText: speech.spokenText(ai).started,
        speechMs: now(context) - overlap.startedAt,
        messages: context.messages,
      };
      const verdictEvent = (verdict: InterruptionVerdict) => ({
        type: "_overlap:verdict" as const,
        turnId: ai.id,
        verdict,
        transcript,
        isFinal,
        timestamp: now(context),
      });

      const classifier = context.config.interruption.classifier;
      if (!classifier) {
        enqueue.raise(verdictEvent(classifyInterruption(input, context.config.interruption)));
        return;
      }
      enqueue(() => {
        let result: InterruptionVerdict | Promise<InterruptionVerdict>;
        try {
          result = classifier(input);
        } catch (error) {
          result = Promise.reject(error);
        }
        Promise.resolve(result).then(
          (verdict) => self.send(verdictEvent(verdict)),
          (error: unknown) => {
            if (context.config.debug)
              console.error("[agent] Interruption classifier failed:", error);
            self.send(verdictEvent("undecided"));
          },
        );
      });
    }),

    recordOverlapVerdict: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || event.type !== "_overlap:verdict" || event.turnId !== ai.id) return;
      enqueue(() =>
        trace(context.config, {
          type: "overlap:verdict",
          turnId: ai.id,
          data: { verdict: event.verdict, isFinal: event.isFinal, length: event.transcript.length },
        }),
      );
      enqueue.assign({
        ai: {
          ...ai,
          echoSuspected: ai.echoSuspected || event.verdict === "echo",
          overlap: ai.overlap
            ? {
                ...ai.overlap,
                verdict: event.verdict === "undecided" ? ai.overlap.verdict : event.verdict,
              }
            : null,
        },
      });
    }),

    appendUserMessage: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_human:committed") return;
      const messages = appendUserMessage(context.messages, event.transcript, {
        merge: context.userAwaitingAnswer,
        maxMessages: context.config.maxMessages,
      });
      enqueue.assign({ messages, userAwaitingAnswer: true, userTurnCommitting: false });
      enqueue.sendTo("turnDetector", {
        type: "_context:messages",
        messages,
        timestamp: now(context),
      });
    }),

    queueUserTurn: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_human:committed") return;
      enqueue.assign({
        queuedUserTranscripts: [...context.queuedUserTranscripts, event.transcript],
        userTurnCommitting: false,
      });
    }),

    startAITurn: enqueueActions(({ context, enqueue, self }) => {
      if (context.ai) return;
      const ai = speech.createAITurn({
        now: now(context),
        tracksPlayback: tracksPlayback(context),
      });
      const timestamp = now(context);
      enqueue.assign({
        ai,
        isSpeaking: false,
        metrics: metrics.recordAITurnStart(context.metrics, timestamp),
      });
      enqueue(() => trace(context.config, { type: "ai-turn:started", turnId: ai.id }));
      enqueue.emit({ type: "ai-turn:started", turnId: ai.id, timestamp });
      enqueue.spawnChild("llm", {
        id: ai.generationId,
        input: llmInput(context, ai, context.messages, self),
      });
    }),

    queueScriptedSpeech: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_agent:say" || !event.text.trim()) return;
      enqueue.assign({ pendingSay: [...context.pendingSay, event.text.trim()] });
    }),

    startScriptedTurn: enqueueActions(({ context, enqueue }) => {
      const [text, ...rest] = context.pendingSay;
      if (!text) return;
      const timestamp = now(context);
      const sentences = splitAllSentences(text);
      let ai: AITurn = {
        ...speech.createAITurn({ now: timestamp, tracksPlayback: tracksPlayback(context) }),
        llmCompleted: true,
        completedText: text,
      };
      for (const sentence of sentences) ai = speech.enqueueSentence(ai, sentence);
      const turnId = ai.id;

      enqueue.assign({
        ai,
        pendingSay: rest,
        isSpeaking: false,
        metrics: metrics.recordAITurnStart(context.metrics, timestamp),
      });
      enqueue(() =>
        trace(context.config, {
          type: "ai-turn:started",
          turnId,
          data: { scripted: true, length: text.length },
        }),
      );
      enqueue.emit({ type: "ai-turn:started", turnId, timestamp });
      sentences.forEach((sentence, index) =>
        enqueue.emit({ type: "ai-turn:sentence", turnId, sentence, index, timestamp }),
      );
    }),

    sayFiller: enqueueActions(({ context, enqueue }) => {
      const ai = context.ai;
      if (!ai) return;
      const { phrases } = context.config.fillers;
      const phrase = phrases[context.phraseIndex.filler % phrases.length] ?? "";
      enqueue.assign({
        ai: speech.enqueueFiller(ai, phrase),
        phraseIndex: { ...context.phraseIndex, filler: context.phraseIndex.filler + 1 },
      });
      enqueue(() =>
        trace(context.config, { type: "ai-turn:filler", turnId: ai.id, data: { phrase } }),
      );
    }),

    raiseBackchannel: enqueueActions(({ context, enqueue }) => {
      enqueue.raise({ type: "_backchannel:speak", timestamp: now(context) });
    }),

    startBackchannel: enqueueActions(({ context, enqueue }) => {
      const human = context.human;
      if (!human) return;
      const { phrases } = context.config.backchannels;
      const text = phrases[context.phraseIndex.backchannel % phrases.length] ?? "";
      const backchannel = { id: nanoid(), requestId: nanoid(), text };
      const timestamp = now(context);
      enqueue.assign({
        backchannel,
        human: { ...human, speechSinceBackchannelMs: 0 },
        phraseIndex: { ...context.phraseIndex, backchannel: context.phraseIndex.backchannel + 1 },
      });
      enqueue(() =>
        trace(context.config, {
          type: "backchannel:started",
          turnId: backchannel.id,
          data: { text },
        }),
      );
      enqueue.emit({ type: "agent:backchannel", turnId: backchannel.id, text, timestamp });
      enqueue.sendTo("tts", {
        type: "_tts:speak",
        requestId: backchannel.requestId,
        turnId: backchannel.id,
        text,
        timestamp,
      });
    }),

    deliverBackchannelChunk: enqueueActions(({ context, event, enqueue }) => {
      const backchannel = context.backchannel;
      if (!backchannel || event.type !== "_tts:chunk") return;
      const timestamp = now(context);
      enqueue.emit({
        type: "ai-turn:audio",
        turnId: backchannel.id,
        requestId: backchannel.requestId,
        audio: event.audio,
        timestamp,
      });
      enqueue.sendTo("audioStreamer", {
        type: "_audio:output-chunk",
        audio: event.audio,
        turnId: backchannel.id,
        requestId: backchannel.requestId,
        timestamp,
      });
    }),

    finishBackchannel: enqueueActions(({ context, event, enqueue }) => {
      enqueue.assign({ backchannel: null });
      if (event.type !== "_tts:error") return;
      enqueue.assign({ metrics: metrics.recordError(context.metrics, "tts") });
      enqueue.emit({
        type: "agent:error",
        error: event.error,
        source: "tts",
        timestamp: now(context),
      });
    }),

    promptSilence: enqueueActions(({ context, enqueue }) => {
      const silence = context.config.silence ?? {};
      const promptCount = context.silencePrompts + 1;
      const maxPrompts = silence.maxPrompts ?? DEFAULT_SILENCE_MAX_PROMPTS;
      enqueue.assign({
        silencePrompts: promptCount,
        pendingSay: [...context.pendingSay, silence.promptMessage ?? DEFAULT_SILENCE_PROMPT],
      });
      enqueue(() =>
        trace(context.config, { type: "silence:detected", data: { promptCount, maxPrompts } }),
      );
      enqueue.emit({ type: "silence:detected", promptCount, maxPrompts, timestamp: now(context) });
    }),

    startSpeculativeTurn: enqueueActions(({ context, event, enqueue, self }) => {
      const inputTranscript = eagerTranscript(context, event);
      const ai = speech.createAITurn({
        now: now(context),
        tracksPlayback: tracksPlayback(context),
        speculative: true,
        inputTranscript,
      });
      const messages = appendUserMessage(context.messages, inputTranscript, {
        merge: context.userAwaitingAnswer,
        maxMessages: context.config.maxMessages,
      });
      enqueue.assign({
        ai,
        metrics: metrics.recordAITurnStart(context.metrics, now(context)),
      });
      enqueue(() =>
        trace(context.config, {
          type: "ai-turn:started",
          turnId: ai.id,
          data: { speculative: true, length: inputTranscript.length },
        }),
      );
      enqueue.spawnChild("llm", {
        id: ai.generationId,
        input: llmInput(context, ai, messages, self),
      });
    }),

    adoptSpeculativeTurn: enqueueActions(({ context, enqueue }) => {
      const ai = context.ai;
      if (!ai) return;
      const timestamp = now(context);
      enqueue(() => {
        ai.commitment.settle(true);
        trace(context.config, {
          type: "ai-turn:committed",
          turnId: ai.id,
          data: { heldChunks: ai.held.length, bufferedEvents: ai.pendingEvents.length },
        });
      });
      enqueue.emit({ type: "ai-turn:started", turnId: ai.id, timestamp });
      ai.pendingEvents.forEach((pending) => enqueue.emit({ ...pending, timestamp }));

      const committed: AITurn = {
        ...ai,
        speculative: false,
        pendingEvents: [],
        outputHeld: false,
        held: [],
      };
      const delivery = deliverChunks(
        { ...context, metrics: metrics.recordAITurnAdopted(context.metrics, timestamp) },
        committed,
        ai.held,
      );
      enqueue.assign({
        ai: delivery.ai,
        metrics: delivery.metrics,
        isSpeaking: ai.active !== null || ai.queue.length > 0 || ai.held.length > 0,
        userAwaitingAnswer: context.userAwaitingAnswer && ai.held.length === 0,
      });
      enqueue(() => delivery.traces.forEach((entry) => trace(context.config, entry)));
      delivery.emitted.forEach((emitted) => enqueue.emit(emitted));
      delivery.streamed.forEach((streamed) => enqueue.sendTo("audioStreamer", streamed));
    }),

    discardSpeculativeTurn: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai) return;
      enqueue(() => {
        ai.commitment.settle(false);
        trace(context.config, {
          type: "ai-turn:discarded",
          turnId: ai.id,
          data: { reason: event.type, heldChunks: ai.held.length },
        });
      });
      enqueue.assign({ ai: null, isSpeaking: false });
    }),

    handleLLMToken: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || event.type !== "_llm:token") return;
      const published: PublicAgentEvent = {
        type: "ai-turn:token",
        turnId: ai.id,
        token: event.token,
        timestamp: now(context),
      };
      enqueue.assign({
        ai: {
          ...ai,
          generatedText: ai.generatedText + event.token,
          pendingEvents: ai.speculative ? [...ai.pendingEvents, published] : ai.pendingEvents,
        },
        metrics: metrics.recordToken(context.metrics, now(context), event.token),
      });
      if (!ai.speculative) enqueue.emit(published);
    }),

    handleLLMSentence: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || event.type !== "_llm:sentence") return;
      const published: PublicAgentEvent = {
        type: "ai-turn:sentence",
        turnId: ai.id,
        sentence: event.sentence,
        index: event.index,
        timestamp: now(context),
      };
      const queued = speech.enqueueSentence(ai, event.sentence);
      enqueue.assign({
        ai: ai.speculative
          ? { ...queued, pendingEvents: [...queued.pendingEvents, published] }
          : queued,
        metrics: metrics.recordSentence(context.metrics, now(context)),
      });
      enqueue(() =>
        trace(context.config, {
          type: "ai-turn:sentence-queued",
          turnId: ai.id,
          data: {
            index: event.index,
            queueDepth: ai.queue.length + 1,
            length: event.sentence.length,
            preview: event.sentence.slice(0, 120),
          },
        }),
      );
      if (!ai.speculative) enqueue.emit(published);
    }),

    handleLLMComplete: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || event.type !== "_llm:complete") return;
      enqueue.assign({
        ai: { ...ai, llmCompleted: true, completedText: event.fullText },
        metrics: metrics.recordResponseLength(context.metrics, event.fullText.length),
      });
      enqueue.stopChild(ai.generationId);
    }),

    enqueueFiller: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || event.type !== "_llm:say" || !event.text.trim()) return;
      enqueue.assign({ ai: speech.enqueueFiller(ai, event.text) });
    }),

    recordPlaybackReport: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (event.type !== "_playback:report" || !ai?.playback || event.turnId !== ai.id) return;
      enqueue.assign({
        ai: { ...ai, playback: reportPlayback(ai.playback, now(context), event.playedMs) },
      });
    }),

    recordWordTimings: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_tts:words" || !context.ai) return;
      enqueue.assign({
        ai: speech.recordWordTimings(context.ai, event.requestId, event.words),
      });
    }),

    dropFillers: enqueueActions(({ context, enqueue }) => {
      if (!context.ai) return;
      const { ai, activeFillerCleared } = speech.dropFillers(context.ai);
      enqueue.assign({ ai });
      if (activeFillerCleared) {
        enqueue.sendTo("tts", { type: "_tts:clear", timestamp: now(context) });
      }
    }),

    dispatchSpeech: enqueueActions(({ context, enqueue }) => {
      const ai = context.ai;
      if (!ai || ai.active || ai.queue.length === 0 || context.backchannel) return;
      const next = speech.startNextSpeech(ai);
      const item = next.active;
      if (!item) return;
      enqueue.assign({ ai: next, isSpeaking: !next.speculative });
      enqueue.sendTo("tts", {
        type: "_tts:speak",
        requestId: item.requestId,
        turnId: ai.id,
        text: item.text,
        timestamp: now(context),
      });
      enqueue(() =>
        trace(context.config, {
          type: "tts:queue",
          turnId: ai.id,
          requestId: item.requestId,
          data: { queueDepth: next.queue.length, kind: item.kind },
        }),
      );
    }),

    handleTTSChunk: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || event.type !== "_tts:chunk") return;
      const chunk = { requestId: event.requestId, audio: event.audio };
      if (ai.outputHeld) {
        enqueue.assign({ ai: speech.recordChunk(ai, chunk) });
        return;
      }
      const delivery = deliverChunks(context, ai, [chunk]);
      enqueue.assign({ ai: delivery.ai, metrics: delivery.metrics, userAwaitingAnswer: false });
      enqueue(() => delivery.traces.forEach((entry) => trace(context.config, entry)));
      delivery.emitted.forEach((emitted) => enqueue.emit(emitted));
      delivery.streamed.forEach((streamed) => enqueue.sendTo("audioStreamer", streamed));
    }),

    handleTTSComplete: enqueueActions(({ context, enqueue }) => {
      if (!context.ai) return;
      enqueue.assign({ ai: speech.finishActiveSpeech(context.ai, true) });
    }),

    handleTTSError: enqueueActions(({ context, event, enqueue }) => {
      if (!context.ai || event.type !== "_tts:error") return;
      enqueue.assign({
        ai: speech.finishActiveSpeech(context.ai, false),
        metrics: metrics.recordError(context.metrics, "tts"),
      });
      enqueue.emit({
        type: "agent:error",
        error: event.error,
        source: "tts",
        timestamp: now(context),
      });
    }),

    beginOverlap: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || ai.overlap) return;
      const startedAt = event.type === "_voice:start" ? event.timestamp : now(context);
      enqueue.assign({ ai: { ...ai, overlap: startOverlap(startedAt) } });
    }),

    clearOverlap: enqueueActions(({ context, enqueue }) => {
      if (!context.ai) return;
      enqueue.assign({ ai: { ...context.ai, overlap: null } });
    }),

    holdOutput: enqueueActions(({ context, enqueue }) => {
      const ai = context.ai;
      if (!ai) return;
      const timestamp = now(context);
      const partialText = speech.generatedResponse(ai);
      const playback = ai.playback ? pausePlayback(ai.playback, timestamp) : null;
      const clears = context.config.interruption.pendingAudio === "clear";
      enqueue.assign({
        ai: {
          ...speech.holdOutput(ai),
          playback,
          replayFromMs: clears && ai.audioDelivered && playback ? playback.position : null,
        },
      });
      enqueue(() =>
        trace(context.config, {
          type: "interruption:pending",
          turnId: ai.id,
          data: {
            partialLength: partialText.length,
            audioStarted: ai.audioDelivered,
            pendingAudio: context.config.interruption.pendingAudio,
          },
        }),
      );
      enqueue.emit({
        type: "ai-turn:interruption-pending",
        turnId: ai.id,
        partialText,
        timestamp,
      });
      if (!ai.audioDelivered) return;
      if (context.config.interruption.pendingAudio === "pause") {
        enqueue.emit({ type: "audio:pause", turnId: ai.id, timestamp });
        return;
      }
      enqueue.emit({ type: "audio:clear", turnId: ai.id, timestamp });
      enqueue.sendTo("audioStreamer", {
        type: "_audio:output-clear",
        turnId: ai.id,
        timestamp,
      });
    }),

    resumeOutput: enqueueActions(
      ({ context, event, enqueue }, params: { reason?: InterruptionCancelReason } | undefined) => {
        const ai = context.ai;
        if (!ai) return;
        const timestamp = now(context);
        const verdict = event.type === "_overlap:verdict" ? event.verdict : ai.overlap?.verdict;
        const reason: InterruptionCancelReason =
          params?.reason ??
          (verdict === "backchannel"
            ? "backchannel"
            : verdict === "echo"
              ? "echo"
              : "no-transcript");
        enqueue(() =>
          trace(context.config, {
            type: "interruption:cancelled",
            turnId: ai.id,
            data: { reason: reason, heldChunks: ai.held.length },
          }),
        );
        enqueue.emit({
          type: "ai-turn:interruption-cancelled",
          turnId: ai.id,
          partialText: speech.generatedResponse(ai),
          reason: reason,
          timestamp,
        });
        if (ai.holdNotified) {
          enqueue.emit({ type: "audio:resume", turnId: ai.id, timestamp });
        }
        const resumed: AITurn = {
          ...ai,
          outputHeld: false,
          holdNotified: false,
          held: [],
          overlap: null,
          replayFromMs: null,
          playback: ai.playback ? resumePlayback(ai.playback, timestamp) : null,
        };
        if (ai.replayFromMs !== null) {
          const replay = audioEvents(ai, replayChunks(context, ai, ai.replayFromMs), timestamp);
          enqueue(() => replay.traces.forEach((entry) => trace(context.config, entry)));
          replay.emitted.forEach((emitted) => enqueue.emit(emitted));
          replay.streamed.forEach((streamed) => enqueue.sendTo("audioStreamer", streamed));
        }
        const delivery = deliverChunks(context, resumed, ai.held);
        enqueue.assign({
          ai: delivery.ai,
          metrics: delivery.metrics,
          userAwaitingAnswer: context.userAwaitingAnswer && ai.held.length === 0,
        });
        enqueue(() => delivery.traces.forEach((entry) => trace(context.config, entry)));
        delivery.emitted.forEach((emitted) => enqueue.emit(emitted));
        delivery.streamed.forEach((streamed) => enqueue.sendTo("audioStreamer", streamed));
      },
    ),

    interruptAITurn: enqueueActions(({ context, enqueue }) => {
      const ai = context.ai;
      if (!ai) return;
      const timestamp = now(context);
      const generated = speech.generatedResponse(ai);
      const spoken = speech.spokenText(ai);
      const heard = ai.playback
        ? heardText(speech.timedSentences(ai), playbackPosition(ai.playback, timestamp))
        : spoken.completed;
      const turnMetrics = metrics.recordAITurnInterrupted(context.metrics, timestamp);
      const alreadyCleared =
        ai.holdNotified && context.config.interruption.pendingAudio === "clear";

      enqueue(() =>
        trace(context.config, {
          type: "ai-turn:interrupted",
          turnId: ai.id,
          elapsedMs:
            context.metrics.aiTurnStartTime !== null
              ? timestamp - context.metrics.aiTurnStartTime
              : 0,
          data: {
            partialLength: generated.length,
            audioStartedLength: spoken.started.length,
            audioCompletedLength: spoken.completed.length,
            heardLength: heard.length,
            audioChunks: context.metrics.currentAudioChunkCount,
          },
        }),
      );
      enqueue.emit({
        type: "ai-turn:interrupted",
        turnId: ai.id,
        partialText: generated,
        generatedText: generated,
        audioStartedText: spoken.started,
        audioCompletedText: spoken.completed,
        heardText: heard,
        spokenText: spoken.completed,
        metrics: buildAITurnMetrics(turnMetrics, true, timestamp),
        timestamp,
      });
      if (ai.audioDelivered && !alreadyCleared) {
        enqueue.emit({ type: "audio:clear", turnId: ai.id, timestamp });
        enqueue.sendTo("audioStreamer", {
          type: "_audio:output-clear",
          turnId: ai.id,
          timestamp,
        });
      }
      const messages = appendAssistantMessage(context.messages, heard, context.config.maxMessages);
      enqueue.assign({ ai: null, isSpeaking: false, messages, metrics: turnMetrics });
      if (messages !== context.messages) {
        enqueue.sendTo("turnDetector", { type: "_context:messages", messages, timestamp });
      }
    }),

    completeAITurn: enqueueActions(({ context, enqueue }) => {
      const ai = context.ai;
      if (!ai) return;
      const timestamp = now(context);
      const text = ai.completedText || ai.generatedText;
      const turnMetrics = metrics.recordAITurnComplete(context.metrics, timestamp);

      enqueue(() =>
        trace(context.config, {
          type: "ai-turn:ended",
          turnId: ai.id,
          elapsedMs:
            context.metrics.aiTurnStartTime !== null
              ? timestamp - context.metrics.aiTurnStartTime
              : 0,
          data: {
            wasSpoken: ai.audioDelivered,
            length: text.length,
            audioChunks: context.metrics.currentAudioChunkCount,
          },
        }),
      );
      enqueue.emit({
        type: "ai-turn:ended",
        turnId: ai.id,
        text,
        wasSpoken: ai.audioDelivered,
        metrics: buildAITurnMetrics(turnMetrics, false, timestamp),
        timestamp,
      });
      const messages = appendAssistantMessage(context.messages, text, context.config.maxMessages);
      enqueue.assign({
        ai: null,
        isSpeaking: false,
        messages,
        userAwaitingAnswer: context.userAwaitingAnswer && !text.trim(),
        metrics: turnMetrics,
      });
      if (messages !== context.messages) {
        enqueue.sendTo("turnDetector", { type: "_context:messages", messages, timestamp });
      }
    }),

    failAITurn: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || event.type !== "_llm:error") return;
      enqueue.emit({
        type: "agent:error",
        error: event.error,
        source: "llm",
        timestamp: now(context),
      });
      enqueue.assign({
        ai: null,
        isSpeaking: false,
        metrics: metrics.recordError(context.metrics, "llm"),
      });
    }),

    releaseAITurnResources: enqueueActions(({ context, enqueue }) => {
      const ai = context.ai;
      if (!ai) return;
      if (ai.active) {
        enqueue.sendTo("tts", {
          type: "_tts:clear",
          requestId: ai.active.requestId,
          timestamp: now(context),
        });
      }
      enqueue(() => ai.abortController.abort());
      enqueue.stopChild(ai.generationId);
    }),

    startQueuedUserTurn: enqueueActions(({ context, enqueue }) => {
      const transcript = context.queuedUserTranscripts.join(" ").trim();
      if (!transcript) return;
      enqueue.assign({ queuedUserTranscripts: [], userTurnCommitting: true });
      enqueue.raise({ type: "_human:committed", transcript, timestamp: now(context) });
    }),
  },
});

const yieldToUser = [
  "releaseAITurnResources",
  "beginHumanTurnFromOverlap",
  "interruptAITurn",
] as const;

export const agentMachine = agentMachineSetup.createMachine({
  id: "agent",
  initial: "idle",
  context: ({ input }) => createInitialContext(input.config, input.audioOutput),

  states: {
    idle: {
      on: {
        "_agent:start": { target: "running", actions: "startSession" },
      },
    },

    running: {
      type: "parallel",
      invoke: [
        {
          id: "stt",
          src: "stt",
          input: ({ context }) => ({
            config: context.config,
            abortSignal: context.sessionAbortController.signal,
          }),
        },
        {
          id: "vad",
          src: "vad",
          input: ({ context }) => ({
            config: context.config,
            abortSignal: context.sessionAbortController.signal,
          }),
        },
        {
          id: "turnDetector",
          src: "turnDetector",
          input: ({ context }) => ({
            config: context.config,
            abortSignal: context.sessionAbortController.signal,
          }),
        },
        {
          id: "tts",
          src: "tts",
          input: ({ context }) => ({
            config: context.config,
            abortSignal: context.sessionAbortController.signal,
          }),
        },
        {
          id: "audioStreamer",
          src: "audioStreamer",
          input: ({ context }) => ({ config: context.config, output: context.audioOutput }),
        },
      ],
      on: {
        "_agent:stop": { target: "#agent.stopped" },
        "_audio:input": { actions: "forwardAudioInput" },
        "_stt:error": { actions: "reportProviderError" },
        "_vad:error": { actions: "reportProviderError" },
        "_vad:probability": { actions: "emitVADProbability" },
        "_agent:say": { actions: "queueScriptedSpeech" },
      },
      states: {
        input: {
          initial: "silent",
          on: {
            "_stt:transcript": { actions: "forwardToTurnDetector" },
          },
          states: {
            silent: {
              on: {
                "_voice:start": {
                  target: "active",
                  actions: ["recordVoiceStart", "forwardToTurnDetector"],
                },
              },
            },
            active: {
              on: {
                "_voice:end": {
                  target: "silent",
                  actions: ["recordVoiceEnd", "forwardToTurnDetector"],
                },
              },
            },
          },
        },

        human: {
          initial: "idle",
          states: {
            idle: {
              on: {
                "_voice:start": {
                  guard: "humanMayStart",
                  target: "active",
                  actions: "openHumanTurn",
                },
                "_stt:transcript": [
                  {
                    guard: and(["humanMayStart", "hasTranscriptText", "sttEndsTurn"]),
                    actions: ["openHumanTurn", "recordHumanTranscript", "commitHumanTurn"],
                  },
                  {
                    guard: and(["humanMayStart", "hasTranscriptText"]),
                    target: "active",
                    actions: ["openHumanTurn", "recordHumanTranscript"],
                  },
                ],
                "_turn:end": {
                  guard: and(["humanMayStart", "turnEndHasTranscript"]),
                  actions: ["openHumanTurn", "commitHumanTurn"],
                },
                "_human:begin": [
                  {
                    guard: "beginCommits",
                    actions: ["openHumanTurn", "recordHumanTranscript", "commitHumanTurn"],
                  },
                  {
                    target: "active",
                    actions: ["openHumanTurn", "recordHumanTranscript"],
                  },
                ],
              },
            },
            active: {
              initial: "routing",
              on: {
                "_stt:transcript": [
                  { guard: not("hasTranscriptText") },
                  {
                    guard: "sttEndsTurn",
                    target: "idle",
                    actions: ["recordHumanTranscript", "commitHumanTurn"],
                  },
                  { target: ".routing", actions: "recordHumanTranscript" },
                ],
                "_turn:end": { target: "idle", actions: "commitHumanTurn" },
                "_turn:abandoned": { target: "idle", actions: "abandonHumanTurn" },
                "_turn:prediction": { actions: "recordEndOfTurnProbability" },
              },
              states: {
                routing: {
                  always: [{ guard: "voiceActive", target: "speaking" }, { target: "paused" }],
                },
                speaking: {
                  on: { "_voice:end": "paused" },
                },
                paused: {
                  entry: "maybeEagerEndOfTurn",
                  on: {
                    "_voice:start": "speaking",
                    "_turn:prediction": [
                      {
                        guard: "predictedEndOfTurnDue",
                        target: "#agent.running.human.idle",
                        actions: ["recordEndOfTurnProbability", "commitHumanTurn"],
                      },
                      { target: "paused", reenter: true, actions: "recordEndOfTurnProbability" },
                    ],
                  },
                  after: {
                    backchannelPause: { guard: "backchannelDue", actions: "raiseBackchannel" },
                    humanTurnTimeout: [
                      {
                        guard: and(["humanHasTranscript", "agentEndsTurn"]),
                        target: "#agent.running.human.idle",
                        actions: "commitHumanTurn",
                      },
                      {
                        guard: not("humanHasTranscript"),
                        target: "#agent.running.human.idle",
                        actions: { type: "abandonHumanTurn", params: { reason: "no-transcript" } },
                      },
                    ],
                  },
                },
              },
            },
          },
        },

        ai: {
          initial: "idle",
          on: {
            "_llm:token": { guard: "isCurrentGeneration", actions: "handleLLMToken" },
            "_llm:sentence": {
              guard: "isCurrentGeneration",
              actions: ["handleLLMSentence", "dispatchSpeech"],
            },
            "_llm:complete": { guard: "isCurrentGeneration", actions: "handleLLMComplete" },
            "_llm:say": {
              guard: "isCurrentGeneration",
              actions: ["enqueueFiller", "dispatchSpeech"],
            },
            "_llm:interrupt": {
              guard: "isCurrentGeneration",
              actions: ["dropFillers", "dispatchSpeech"],
            },
            "_tts:chunk": { guard: "isActiveSpeech", actions: "handleTTSChunk" },
            "_tts:words": { guard: "isActiveSpeech", actions: "recordWordTimings" },
            "_playback:report": { actions: "recordPlaybackReport" },
            "_tts:complete": {
              guard: "isActiveSpeech",
              actions: ["handleTTSComplete", "dispatchSpeech"],
            },
            "_tts:error": {
              guard: "isActiveSpeech",
              actions: ["handleTTSError", "dispatchSpeech"],
            },
          },
          states: {
            idle: {
              always: {
                guard: "canSpeakScripted",
                target: "responding",
                actions: ["startScriptedTurn", "dispatchSpeech"],
              },
              on: {
                "_human:committed": { target: "responding", actions: "appendUserMessage" },
                "_turn:eager-end": {
                  guard: and(["preemptiveGenerationEnabled", "eagerTranscriptPresent"]),
                  target: "preparing",
                },
              },
            },
            preparing: {
              entry: "startSpeculativeTurn",
              on: {
                "_human:committed": [
                  {
                    guard: "matchesSpeculativeTranscript",
                    target: "responding",
                    actions: ["appendUserMessage", "adoptSpeculativeTurn"],
                  },
                  {
                    target: "responding",
                    actions: [
                      "releaseAITurnResources",
                      "discardSpeculativeTurn",
                      "appendUserMessage",
                    ],
                  },
                ],
                "_turn:eager-end": {
                  guard: and(["eagerTranscriptPresent", "isNewSpeculativeTranscript"]),
                  target: "preparing",
                  reenter: true,
                  actions: ["releaseAITurnResources", "discardSpeculativeTurn"],
                },
                "_turn:resumed": {
                  target: "idle",
                  actions: ["releaseAITurnResources", "discardSpeculativeTurn"],
                },
                "_turn:abandoned": {
                  target: "idle",
                  actions: ["releaseAITurnResources", "discardSpeculativeTurn"],
                },
                "_voice:start": {
                  guard: "predictionTurnSource",
                  target: "idle",
                  actions: ["releaseAITurnResources", "discardSpeculativeTurn"],
                },
                "_llm:error": {
                  guard: "isCurrentGeneration",
                  target: "idle",
                  actions: ["releaseAITurnResources", "discardSpeculativeTurn"],
                },
              },
            },
            responding: {
              entry: "startAITurn",
              initial: "live",
              on: {
                "_llm:error": {
                  guard: "isCurrentGeneration",
                  target: "idle",
                  actions: ["releaseAITurnResources", "failAITurn", "startQueuedUserTurn"],
                },
                "_human:committed": [
                  { guard: not("interruptionEnabled"), actions: "queueUserTurn" },
                  {
                    target: "responding",
                    reenter: true,
                    actions: ["releaseAITurnResources", "interruptAITurn", "appendUserMessage"],
                  },
                ],
              },
              states: {
                live: {
                  initial: "streaming",
                  // The wait restarts after the user talks over it, so the agent never
                  // fills while they speak.
                  after: {
                    fillerDelay: { guard: "fillerDue", actions: ["sayFiller", "dispatchSpeech"] },
                  },
                  states: {
                    streaming: {
                      always: { guard: "aiTurnComplete", target: "draining" },
                    },
                    draining: {
                      always: {
                        guard: "playoutDone",
                        target: "#agent.running.ai.idle",
                        actions: ["completeAITurn", "startQueuedUserTurn"],
                      },
                      after: { playoutRemaining: { target: "draining", reenter: true } },
                      on: {
                        "_playback:report": {
                          target: "draining",
                          reenter: true,
                          actions: "recordPlaybackReport",
                        },
                      },
                    },
                  },
                  on: {
                    "_voice:start": [
                      {
                        guard: and(["interruptsImmediately", "voiceHoldsFloor"]),
                        target: "#agent.running.ai.idle",
                        actions: ["beginOverlap", ...yieldToUser],
                      },
                      {
                        guard: and(["interruptionEnabled", "voiceHoldsFloor", "cutoffIsImmediate"]),
                        target: "held",
                        actions: "beginOverlap",
                      },
                      {
                        guard: and(["interruptionEnabled", "voiceHoldsFloor"]),
                        target: "contested",
                        actions: "beginOverlap",
                      },
                    ],
                    "_stt:transcript": {
                      guard: and(["interruptionEnabled", "hasTranscriptText"]),
                      actions: "classifyOverlapEvidence",
                    },
                    "_turn:end": {
                      guard: "interruptionEnabled",
                      actions: "classifyOverlapEvidence",
                    },
                    "_overlap:verdict": [
                      {
                        guard: "overlapInterrupts",
                        target: "#agent.running.ai.idle",
                        actions: yieldToUser,
                      },
                      {
                        guard: "overlapAcknowledged",
                        actions: ["recordOverlapVerdict", "clearOverlap"],
                      },
                      { guard: "isCurrentTurnVerdict", actions: "recordOverlapVerdict" },
                    ],
                  },
                },
                contested: {
                  after: { speculativeCutoff: "held" },
                  on: {
                    "_voice:end": { target: "live", actions: "clearOverlap" },
                    "_stt:transcript": {
                      guard: "hasTranscriptText",
                      actions: "classifyOverlapEvidence",
                    },
                    "_turn:end": { actions: "classifyOverlapEvidence" },
                    "_overlap:verdict": [
                      {
                        guard: "overlapInterrupts",
                        target: "#agent.running.ai.idle",
                        actions: yieldToUser,
                      },
                      { guard: "isCurrentTurnVerdict", actions: "recordOverlapVerdict" },
                    ],
                  },
                },
                held: {
                  entry: "holdOutput",
                  initial: "listening",
                  after: {
                    maxPending: {
                      target: "live",
                      actions: { type: "resumeOutput", params: { reason: "no-transcript" } },
                    },
                  },
                  on: {
                    "_stt:transcript": {
                      guard: "hasTranscriptText",
                      actions: "classifyOverlapEvidence",
                    },
                    "_turn:end": { actions: "classifyOverlapEvidence" },
                    "_overlap:verdict": [
                      {
                        guard: "overlapInterrupts",
                        target: "#agent.running.ai.idle",
                        actions: yieldToUser,
                      },
                      {
                        guard: and(["overlapAcknowledged", not("voiceActive")]),
                        target: "live",
                        actions: ["recordOverlapVerdict", "resumeOutput"],
                      },
                      { guard: "isCurrentTurnVerdict", actions: "recordOverlapVerdict" },
                    ],
                  },
                  states: {
                    listening: {
                      on: {
                        "_voice:end": [
                          {
                            guard: "overlapTooShort",
                            target: "#agent.running.ai.responding.live",
                            actions: { type: "resumeOutput", params: { reason: "false-start" } },
                          },
                          {
                            guard: "lastVerdictAcknowledged",
                            target: "#agent.running.ai.responding.live",
                            actions: "resumeOutput",
                          },
                          { target: "waiting" },
                        ],
                      },
                    },
                    waiting: {
                      after: {
                        resumeAfter: {
                          target: "#agent.running.ai.responding.live",
                          actions: "resumeOutput",
                        },
                      },
                      on: { "_voice:start": "listening" },
                    },
                  },
                },
              },
            },
          },
        },

        backchannel: {
          initial: "idle",
          states: {
            idle: {
              on: {
                "_backchannel:speak": { target: "speaking", actions: "startBackchannel" },
              },
            },
            speaking: {
              on: {
                "_tts:chunk": { guard: "isBackchannelSpeech", actions: "deliverBackchannelChunk" },
                "_tts:complete": {
                  guard: "isBackchannelSpeech",
                  target: "idle",
                  actions: ["finishBackchannel", "dispatchSpeech"],
                },
                "_tts:error": {
                  guard: "isBackchannelSpeech",
                  target: "idle",
                  actions: ["finishBackchannel", "dispatchSpeech"],
                },
              },
            },
          },
        },

        silence: {
          initial: "idle",
          states: {
            idle: {
              always: { guard: "silenceWatchActive", target: "waiting" },
            },
            waiting: {
              always: { guard: not("silenceWatchActive"), target: "idle" },
              after: { silenceTimeout: { target: "idle", actions: "promptSilence" } },
            },
          },
        },
      },
    },

    stopped: {
      type: "final",
      entry: "stopSession",
    },
  },

  output: ({ context }) => ({
    messages: context.messages,
    turnCount: context.messages.filter((message) => message.role === "user").length,
  }),
});

export type AgentMachine = typeof agentMachine;
