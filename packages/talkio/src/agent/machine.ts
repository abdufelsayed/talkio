/**
 * Agent State Machine
 *
 * Orchestrates a voice conversation as three parallel regions:
 *
 * - `input`: the user's voice activity, from the VAD provider when one is
 *   configured and from the STT provider otherwise.
 * - `human`: the user's turn. Opens on speech, accumulates transcripts, and
 *   commits when the turn source (final STT transcripts or a turn detector)
 *   says the user is done.
 * - `ai`: the agent's turn. Generates with the LLM, speaks through TTS, and
 *   yields when the user overlaps it. While an interruption is pending the
 *   agent's audio is held, so a false alarm resumes exactly where it stopped.
 *
 * While the agent is responding it owns overlapping user speech and decides
 * whether it is an interruption; once it yields, the human region takes over.
 * Regions coordinate through raised `_human:*` events.
 *
 * @module agent/machine
 */

import { nanoid } from "nanoid";
import { and, enqueueActions, not, setup } from "xstate";

import { audioSampleCount } from "../audio/duration";
import type { AgentMachineOutput } from "../types/common";
import type { NormalizedAgentConfig } from "../types/config";
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
} from "./context";
import { buildAITurnMetrics, buildHumanTurnMetrics } from "./helpers";
import { appendAssistantMessage, appendUserMessage } from "./history";
import * as metrics from "./metrics";
import { classifyOverlapTranscript, type OverlapVerdict } from "./overlap";
import * as speech from "./speech";
import { getConfigNow } from "./time";
import { trace } from "./trace";
import { endOfTurnDelayMs } from "./turn-taking";

/** How long a human turn with no transcript at all may stay open after speech ends. */
const NO_TRANSCRIPT_ABANDON_MS = 2000;

/** How long to wait for a final transcript after speech ends before using the interim one. */
const MISSING_FINAL_COMMIT_MS = 4000;

type Context = AgentMachineContext;
type TraceInput = Parameters<typeof trace>[1];

function now(context: Context): number {
  return getConfigNow(context.config);
}

function humanTranscript(human: HumanTurn): string {
  return [human.finalText, human.interimText].filter(Boolean).join(" ").trim();
}

/** What a transcript or a turn detector decision says about overlapping speech. */
function overlapEvidence(
  context: Context,
  event: MachineEvent,
): { verdict: OverlapVerdict; transcript: string; isFinal: boolean } | null {
  if (event.type === "_stt:transcript") {
    return {
      verdict: classifyOverlapTranscript(event.text, event.isFinal, context.config.interruption),
      transcript: event.text,
      isFinal: event.isFinal,
    };
  }
  if (event.type === "_turn:end") {
    const transcript = event.transcript.trim() || (context.ai?.overlap?.transcript ?? "");
    return {
      verdict: classifyOverlapTranscript(transcript, true, context.config.interruption),
      transcript,
      isFinal: true,
    };
  }
  return null;
}

function overlapElapsedMs(context: Context): number {
  const startedAt = context.ai?.overlap?.startedAt;
  return startedAt === undefined ? 0 : now(context) - startedAt;
}

/** Everything that happens when audio reaches the listener, for a batch of chunks. */
function deliverChunks(context: Context, ai: AITurn, chunks: readonly HeldChunk[]) {
  const timestamp = now(context);
  let delivered = ai;
  let tracked = context.metrics;
  const emitted: AITurnAudioEvent[] = [];
  const streamed: InternalAudioOutputChunkEvent[] = [];
  const traces: TraceInput[] = [];

  for (const chunk of chunks) {
    const samples = audioSampleCount(chunk.audio.byteLength, context.config.audio.output) ?? 0;
    delivered = speech.recordChunk(delivered, chunk);
    tracked = metrics.recordAudioChunk(tracked, timestamp, samples);
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

  return { ai: delivered, metrics: tracked, emitted, streamed, traces };
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
    interruptionConfirm: ({ context }) =>
      Math.max(0, context.config.interruption.minDurationMs - overlapElapsedMs(context)),
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
    interruptsImmediately: ({ context }) =>
      context.config.interruption.enabled && context.config.interruption.minDurationMs === 0,
    cutoffIsImmediate: ({ context }) => context.config.interruption.speculativeCutoffMs === 0,
    humanMayStart: ({ context }) => context.ai === null || !context.config.interruption.enabled,
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
        event.type === "_tts:complete" ||
        event.type === "_tts:error") &&
      event.requestId === context.ai?.active?.requestId,
    aiTurnComplete: ({ context }) =>
      context.ai !== null && context.ai.llmCompleted && speech.isSpeechIdle(context.ai),

    overlapCommits: ({ context, event }) => {
      const evidence = overlapEvidence(context, event);
      return evidence !== null && evidence.isFinal && evidence.verdict === "interrupt";
    },
    overlapCandidate: ({ context, event }) => {
      const evidence = overlapEvidence(context, event);
      return evidence !== null && !evidence.isFinal && evidence.verdict === "interrupt";
    },
    overlapBackchannelEnded: ({ context, event }) => {
      const evidence = overlapEvidence(context, event);
      return (
        evidence !== null &&
        evidence.isFinal &&
        evidence.verdict === "backchannel" &&
        !context.voice.active
      );
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
        quietSince: null,
        endOfTurnProbability: null,
      };
      enqueue.assign({
        human,
        metrics: metrics.recordHumanTurnStart(context.metrics, human.startedAt),
      });
      enqueue(() => trace(context.config, { type: "human-turn:started", turnId: human.id }));
      enqueue.emit({ type: "human-turn:started", turnId: human.id, timestamp: human.startedAt });
    }),

    recordHumanTranscript: enqueueActions(({ context, event, enqueue }) => {
      const human = context.human;
      if (!human) return;
      let text: string;
      let isFinal: boolean;
      if (event.type === "_stt:transcript") {
        text = event.text;
        isFinal = event.isFinal;
      } else if (event.type === "_human:begin") {
        text = event.transcript;
        isFinal = event.commit;
      } else {
        return;
      }
      if (!text.trim()) return;

      const quietSince = context.voice.active ? human.quietSince : now(context);
      enqueue.assign({
        human: isFinal
          ? {
              ...human,
              finalText: [human.finalText, text.trim()].filter(Boolean).join(" "),
              interimText: "",
              quietSince,
            }
          : { ...human, interimText: text.trim(), quietSince },
        partialTranscript: isFinal ? "" : text,
      });
      enqueue.emit({
        type: "human-turn:transcript",
        turnId: human.id,
        text,
        isFinal,
        timestamp: now(context),
      });
    }),

    commitHumanTurn: enqueueActions(({ context, event, enqueue }) => {
      const human = context.human;
      if (!human) return;
      const transcript =
        (event.type === "_turn:end" && event.transcript.trim()) || humanTranscript(human);

      if (!transcript) {
        const abandoned = humanTurnAbandonment(context, human, "empty-transcript");
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

    beginHumanTurnFromOverlap: enqueueActions(({ context, event, enqueue }) => {
      const evidence = overlapEvidence(context, event);
      enqueue.raise({
        type: "_human:begin",
        transcript: evidence?.transcript ?? context.ai?.overlap?.transcript ?? "",
        commit: evidence?.isFinal === true,
        timestamp: now(context),
      });
    }),

    appendUserMessage: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== "_human:committed") return;
      const messages = appendUserMessage(context.messages, event.transcript, {
        merge: context.userAwaitingAnswer,
        maxMessages: context.config.maxMessages,
      });
      enqueue.assign({ messages, userAwaitingAnswer: true });
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
      });
    }),

    startAITurn: enqueueActions(({ context, enqueue, self }) => {
      const ai = speech.createAITurn();
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
        input: {
          config: context.config,
          messages: context.messages,
          abortSignal: ai.abortController.signal,
          turnId: ai.id,
          generationId: ai.generationId,
          isSpeaking: () => self.getSnapshot().context.isSpeaking,
        },
      });
    }),

    handleLLMToken: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || event.type !== "_llm:token") return;
      enqueue.assign({
        ai: { ...ai, generatedText: ai.generatedText + event.token },
        metrics: metrics.recordToken(context.metrics, now(context), event.token),
      });
      enqueue.emit({
        type: "ai-turn:token",
        turnId: ai.id,
        token: event.token,
        timestamp: now(context),
      });
    }),

    handleLLMSentence: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai || event.type !== "_llm:sentence") return;
      enqueue.assign({
        ai: speech.enqueueSentence(ai, event.sentence),
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
      enqueue.emit({
        type: "ai-turn:sentence",
        turnId: ai.id,
        sentence: event.sentence,
        index: event.index,
        timestamp: now(context),
      });
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
      if (!ai || ai.active || ai.queue.length === 0) return;
      const next = speech.startNextSpeech(ai);
      const item = next.active;
      if (!item) return;
      enqueue.assign({ ai: next, isSpeaking: true });
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
      const transcript = event.type === "_stt:transcript" ? event.text : "";
      const startedAt =
        event.type === "_voice:start" ? event.timestamp : (context.voice.startedAt ?? now(context));
      enqueue.assign({ ai: { ...ai, overlap: { startedAt, transcript } } });
    }),

    updateOverlapTranscript: enqueueActions(({ context, event, enqueue }) => {
      const ai = context.ai;
      if (!ai?.overlap || event.type !== "_stt:transcript" || !event.text.trim()) return;
      enqueue.assign({ ai: { ...ai, overlap: { ...ai.overlap, transcript: event.text } } });
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
      enqueue.assign({ ai: speech.holdOutput(ai) });
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
      ({ context, enqueue }, params: { reason: InterruptionCancelReason }) => {
        const ai = context.ai;
        if (!ai) return;
        const timestamp = now(context);
        enqueue(() =>
          trace(context.config, {
            type: "interruption:cancelled",
            turnId: ai.id,
            data: { reason: params.reason, heldChunks: ai.held.length },
          }),
        );
        enqueue.emit({
          type: "ai-turn:interruption-cancelled",
          turnId: ai.id,
          partialText: speech.generatedResponse(ai),
          reason: params.reason,
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
        };
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
      const messages = appendAssistantMessage(
        context.messages,
        spoken.completed,
        context.config.maxMessages,
      );
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
      enqueue.assign({ queuedUserTranscripts: [] });
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
          states: {
            idle: {
              on: {
                "_human:committed": { target: "responding", actions: "appendUserMessage" },
              },
            },
            responding: {
              entry: "startAITurn",
              initial: "live",
              on: {
                "_llm:token": { guard: "isCurrentGeneration", actions: "handleLLMToken" },
                "_llm:sentence": {
                  guard: "isCurrentGeneration",
                  actions: ["handleLLMSentence", "dispatchSpeech"],
                },
                "_llm:complete": { guard: "isCurrentGeneration", actions: "handleLLMComplete" },
                "_llm:error": {
                  guard: "isCurrentGeneration",
                  target: "idle",
                  actions: ["releaseAITurnResources", "failAITurn", "startQueuedUserTurn"],
                },
                "_llm:say": {
                  guard: "isCurrentGeneration",
                  actions: ["enqueueFiller", "dispatchSpeech"],
                },
                "_llm:interrupt": {
                  guard: "isCurrentGeneration",
                  actions: ["dropFillers", "dispatchSpeech"],
                },
                "_tts:chunk": { guard: "isActiveSpeech", actions: "handleTTSChunk" },
                "_tts:complete": {
                  guard: "isActiveSpeech",
                  actions: ["handleTTSComplete", "dispatchSpeech"],
                },
                "_tts:error": {
                  guard: "isActiveSpeech",
                  actions: ["handleTTSError", "dispatchSpeech"],
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
                  always: {
                    guard: "aiTurnComplete",
                    target: "#agent.running.ai.idle",
                    actions: ["completeAITurn", "startQueuedUserTurn"],
                  },
                  on: {
                    "_voice:start": [
                      {
                        guard: "interruptsImmediately",
                        target: "#agent.running.ai.idle",
                        actions: ["beginOverlap", ...yieldToUser],
                      },
                      {
                        guard: and(["interruptionEnabled", "cutoffIsImmediate"]),
                        target: "held",
                        actions: "beginOverlap",
                      },
                      {
                        guard: "interruptionEnabled",
                        target: "contested",
                        actions: "beginOverlap",
                      },
                    ],
                    "_stt:transcript": [
                      {
                        guard: and(["interruptionEnabled", "overlapCommits"]),
                        target: "#agent.running.ai.idle",
                        actions: yieldToUser,
                      },
                      {
                        guard: and(["interruptionEnabled", "overlapCandidate"]),
                        target: "held",
                        actions: "beginOverlap",
                      },
                    ],
                    "_turn:end": {
                      guard: and(["interruptionEnabled", "overlapCommits"]),
                      target: "#agent.running.ai.idle",
                      actions: yieldToUser,
                    },
                  },
                },
                contested: {
                  after: { speculativeCutoff: "held" },
                  on: {
                    "_voice:end": { target: "live", actions: "clearOverlap" },
                    "_stt:transcript": [
                      {
                        guard: "overlapCommits",
                        target: "#agent.running.ai.idle",
                        actions: yieldToUser,
                      },
                      {
                        guard: "overlapCandidate",
                        target: "held",
                        actions: "updateOverlapTranscript",
                      },
                      { actions: "updateOverlapTranscript" },
                    ],
                    "_turn:end": {
                      guard: "overlapCommits",
                      target: "#agent.running.ai.idle",
                      actions: yieldToUser,
                    },
                  },
                },
                held: {
                  entry: "holdOutput",
                  after: {
                    interruptionConfirm: {
                      target: "#agent.running.ai.idle",
                      actions: yieldToUser,
                    },
                  },
                  on: {
                    "_voice:end": [
                      {
                        guard: "overlapTooShort",
                        target: "live",
                        actions: { type: "resumeOutput", params: { reason: "false-start" } },
                      },
                      { target: "#agent.running.ai.idle", actions: yieldToUser },
                    ],
                    "_stt:transcript": [
                      {
                        guard: "overlapCommits",
                        target: "#agent.running.ai.idle",
                        actions: yieldToUser,
                      },
                      {
                        guard: "overlapBackchannelEnded",
                        target: "live",
                        actions: { type: "resumeOutput", params: { reason: "backchannel" } },
                      },
                      { actions: "updateOverlapTranscript" },
                    ],
                    "_turn:end": [
                      {
                        guard: "overlapCommits",
                        target: "#agent.running.ai.idle",
                        actions: yieldToUser,
                      },
                      {
                        guard: "overlapBackchannelEnded",
                        target: "live",
                        actions: { type: "resumeOutput", params: { reason: "backchannel" } },
                      },
                    ],
                  },
                },
              },
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
