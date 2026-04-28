/**
 * Agent State Machine
 *
 * Core XState machine that orchestrates the complete voice agent lifecycle.
 *
 * This machine coordinates all aspects of a voice conversation:
 * - **Lifecycle Management**: Starting/stopping providers, managing resources
 * - **Turn Management**: Detecting user turns, generating AI responses, handling interruptions
 * - **Interruption Detection**: Allowing users to interrupt the agent while speaking
 * - **Provider Coordination**: Orchestrating STT, LLM, TTS, VAD, and turn detector actors
 * - **Event Emission**: Translating internal machine events to public user-facing events
 * - **Metrics Tracking**: Collecting performance and usage metrics throughout the session
 * - **Error Handling**: Managing errors from providers and propagating them appropriately
 *
 * The machine uses a hierarchical state structure:
 * - `idle` - Initial state, agent not running
 * - `running` - Agent is active and processing
 *   - `listening` - Waiting for user input
 *   - `processing` - Generating response (LLM active)
 *   - `speaking` - Synthesizing speech (TTS active)
 *
 * State transitions are driven by events from providers and user actions.
 * The machine emits public events via the `onEvent` callback for observability.
 *
 * @module agent/machine
 */

import { nanoid } from "nanoid";
import { and, assign, emit, sendTo, setup } from "xstate";

import type { AgentMachineOutput } from "../types/common";
import type { NormalizedAgentConfig } from "../types/config";
import type { MachineEvent, PublicAgentEvent } from "../types/events";
import {
  audioStreamerActor,
  llmActor,
  sttActor,
  ttsActor,
  turnDetectorActor,
  vadActor,
} from "./actors";
import { type AgentMachineContext, createInitialContext } from "./context";
import { buildAITurnMetrics, buildHumanTurnMetrics, getTTSText } from "./helpers";
import { clearConfigTimeout, getConfigNow, setConfigTimeout } from "./time";

function now(context: AgentMachineContext): number {
  return getConfigNow(context.config);
}

function interruptionMinDuration(context: AgentMachineContext): number {
  return context.config.interruption?.minDurationMs ?? 200;
}

function interruptionSpeculativeCutoffDelay(context: AgentMachineContext): number {
  const configuredDelay = context.config.interruption?.speculativeCutoffMs ?? 0;
  return Math.min(Math.max(configuredDelay, 0), interruptionMinDuration(context));
}

function hasActiveAITurnContext(context: AgentMachineContext): boolean {
  return context.llmRef !== null || context.ttsRef !== null || context.pendingTTSCount > 0;
}

const agentMachineSetup = setup({
  types: {
    context: {} as AgentMachineContext,
    events: {} as MachineEvent,
    input: {} as {
      config: NormalizedAgentConfig;
      audioStreamController: ReadableStreamDefaultController<ArrayBuffer> | null;
    },
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

  guards: {
    // VAD/Turn source guards
    hasVADAdapter: ({ context }) => context.vadSource === "adapter",
    usesSTTForVAD: ({ context }) => context.vadSource === "stt",
    hasTurnDetector: ({ context }) => context.turnSource === "adapter",
    noTurnDetector: ({ context }) => context.turnSource === "stt",

    // Atomic guards for composition
    interruptionEnabled: ({ context }) => context.config.interruption?.enabled ?? false,
    isSpeaking: ({ context }) => context.isSpeaking,
    isNotSpeaking: ({ context }) => !context.isSpeaking,
    sufficientDuration: ({ context, event }) => {
      if (event.type !== "_vad:speech-end") return true;
      return event.duration >= interruptionMinDuration(context);
    },

    sttSpeechDurationMet: ({ context }) => {
      if (context.speechStartedAt === null) return false;
      return now(context) - context.speechStartedAt >= interruptionMinDuration(context);
    },

    hasPendingInterruption: ({ context }) => context.pendingInterruptionStartedAt !== null,
    hasEmittedInterruptionPending: ({ context }) => context.pendingInterruptionCutoffEmitted,
    shouldEmitInterruptionPendingImmediately: ({ context }) =>
      interruptionSpeculativeCutoffDelay(context) === 0,

    pendingInterruptionDurationMet: ({ context }) => {
      if (context.pendingInterruptionStartedAt === null) return false;
      return (
        now(context) - context.pendingInterruptionStartedAt >= interruptionMinDuration(context)
      );
    },

    // Composed interruption guards
    shouldStartPendingInterruption: and(["interruptionEnabled", "isSpeaking"]),
    shouldStartPendingInterruptionImmediately: and([
      "shouldStartPendingInterruption",
      "shouldEmitInterruptionPendingImmediately",
    ]),
    shouldEmitPendingInterruption: and([
      "interruptionEnabled",
      "isSpeaking",
      "hasPendingInterruption",
    ]),
    shouldCancelEmittedPendingInterruption: and([
      "hasPendingInterruption",
      "hasEmittedInterruptionPending",
    ]),
    shouldConfirmPendingInterruption: and([
      "interruptionEnabled",
      "isSpeaking",
      "hasPendingInterruption",
      "pendingInterruptionDurationMet",
    ]),
    shouldInterruptOnPendingSpeechEnd: and([
      "interruptionEnabled",
      "isSpeaking",
      "hasPendingInterruption",
      "sufficientDuration",
    ]),
    canInterruptFromSTT: and([
      "usesSTTForVAD",
      "interruptionEnabled",
      "isSpeaking",
      "sttSpeechDurationMet",
    ]),
    shouldStartPendingSTTInterruption: and(["usesSTTForVAD", "shouldStartPendingInterruption"]),
    shouldStartPendingSTTInterruptionImmediately: and([
      "shouldStartPendingSTTInterruption",
      "shouldEmitInterruptionPendingImmediately",
    ]),

    // Queue/TTS guards
    hasPendingSentences: ({ context }) => context.sentenceQueue.length > 0,
    hasPendingTTS: ({ context }) => context.pendingTTSCount > 0,
    noPendingTTS: ({ context }) => context.pendingTTSCount === 0,
    matchesActiveTTSRequest: ({ context, event }) =>
      (event.type === "_tts:chunk" ||
        event.type === "_tts:complete" ||
        event.type === "_tts:error") &&
      context.activeTTSRequestId !== null &&
      event.requestId === context.activeTTSRequestId,
    speakingCurrentTTS: and(["isSpeaking", "matchesActiveTTSRequest"]),
    hasPendingSentencesForCurrentTTS: and(["hasPendingSentences", "matchesActiveTTSRequest"]),

    // Turn state guards
    aiTurnHadNoAudio: ({ context }) => !context.aiTurnHadAudio,
    hasActiveAITurn: ({ context }) => hasActiveAITurnContext(context),
  },

  actions: {
    // Emit actions
    emitAgentStarted: emit(({ context }) => ({
      type: "agent:started" as const,
      timestamp: now(context),
    })),
    emitAgentStopped: emit(({ context }) => ({
      type: "agent:stopped" as const,
      timestamp: now(context),
    })),
    emitAgentError: emit(({ context, event }) => {
      let error: Error;
      let source: "stt" | "llm" | "tts" | "vad";

      if (event.type === "_stt:error") {
        error = event.error;
        source = "stt";
      } else if (event.type === "_llm:error") {
        error = event.error;
        source = "llm";
      } else if (event.type === "_tts:error") {
        error = event.error;
        source = "tts";
      } else if (event.type === "_vad:error") {
        error = event.error;
        source = "vad";
      } else {
        error = new Error("Unknown error");
        source = "stt";
      }

      return { type: "agent:error" as const, error, source, timestamp: now(context) };
    }),

    // Human turn events
    emitHumanTurnStarted: emit(({ context }) => ({
      type: "human-turn:started" as const,
      timestamp: now(context),
    })),
    emitHumanTurnTranscript: emit(({ context, event }) => {
      if (event.type === "_stt:transcript") {
        return {
          type: "human-turn:transcript" as const,
          text: event.text,
          isFinal: event.isFinal,
          timestamp: now(context),
        };
      }
      return {
        type: "human-turn:transcript" as const,
        text: "",
        isFinal: false,
        timestamp: now(context),
      };
    }),
    emitHumanTurnEnded: emit(({ context, event }) => {
      let transcript = "";
      if (event.type === "_turn:end") {
        transcript = event.transcript;
      } else if (event.type === "_stt:transcript" && event.isFinal) {
        transcript = event.text;
      }
      return {
        type: "human-turn:ended" as const,
        transcript,
        metrics: buildHumanTurnMetrics(context.metrics),
        timestamp: now(context),
      };
    }),
    emitHumanTurnAbandoned: emit(({ context, event }) => {
      const reason = event.type === "_turn:abandoned" ? event.reason : "unknown";
      return { type: "human-turn:abandoned" as const, reason, timestamp: now(context) };
    }),
    emitAITurnStarted: emit(({ context }) => ({
      type: "ai-turn:started" as const,
      timestamp: now(context),
    })),
    emitAITurnToken: emit(({ context, event }) => {
      const token = event.type === "_llm:token" ? event.token : "";
      return { type: "ai-turn:token" as const, token, timestamp: now(context) };
    }),
    emitAITurnSentence: emit(({ context, event }) => {
      if (event.type === "_llm:sentence") {
        return {
          type: "ai-turn:sentence" as const,
          sentence: event.sentence,
          index: event.index,
          timestamp: now(context),
        };
      }
      return {
        type: "ai-turn:sentence" as const,
        sentence: "",
        index: 0,
        timestamp: now(context),
      };
    }),
    emitAITurnAudio: emit(({ context, event }) => {
      const audio = event.type === "_tts:chunk" ? event.audio : new ArrayBuffer(0);
      return { type: "ai-turn:audio" as const, audio, timestamp: now(context) };
    }),
    emitAITurnEnded: emit(({ context }) => ({
      type: "ai-turn:ended" as const,
      text: context.lastLLMResponse,
      wasSpoken: context.aiTurnHadAudio,
      metrics: buildAITurnMetrics(context.metrics, false, now(context)),
      timestamp: now(context),
    })),
    emitAITurnInterrupted: emit(({ context }) => ({
      type: "ai-turn:interrupted" as const,
      partialText: context.currentResponse,
      metrics: buildAITurnMetrics(context.metrics, true, now(context)),
      timestamp: now(context),
    })),
    emitAITurnInterruptionPending: emit(({ context }) => ({
      type: "ai-turn:interruption-pending" as const,
      partialText: context.currentResponse,
      timestamp: now(context),
    })),
    emitAITurnInterruptionCancelled: emit(({ context }) => ({
      type: "ai-turn:interruption-cancelled" as const,
      partialText: context.currentResponse,
      timestamp: now(context),
    })),

    // Debug events
    emitVADProbability: emit(({ context, event }) => {
      const value = event.type === "_vad:probability" ? event.value : 0;
      return { type: "vad:probability" as const, value, timestamp: now(context) };
    }),

    updatePartialTranscriptFromEvent: assign({
      partialTranscript: ({ event }) =>
        event.type === "_stt:transcript" && !event.isFinal ? event.text : "",
    }),

    clearPartialTranscript: assign({ partialTranscript: () => "" }),

    addUserMessageFromTurnEnd: assign({
      messages: ({ context, event }) => {
        const text = event.type === "_turn:end" ? event.transcript : "";
        const newMessages = [...context.messages, { role: "user" as const, content: text }];
        const maxMessages = context.config.maxMessages ?? 100;
        return newMessages.length > maxMessages ? newMessages.slice(-maxMessages) : newMessages;
      },
      partialTranscript: () => "",
    }),

    addUserMessageFromSTT: assign({
      messages: ({ context, event }) => {
        const text = event.type === "_stt:transcript" && event.isFinal ? event.text : "";
        const newMessages = [...context.messages, { role: "user" as const, content: text }];
        const maxMessages = context.config.maxMessages ?? 100;
        return newMessages.length > maxMessages ? newMessages.slice(-maxMessages) : newMessages;
      },
      partialTranscript: () => "",
    }),

    addAssistantMessageFromEvent: assign({
      messages: ({ context, event }) => {
        const fullText = event.type === "_llm:complete" ? event.fullText : "";
        const newMessages = [
          ...context.messages,
          { role: "assistant" as const, content: fullText },
        ];
        const maxMessages = context.config.maxMessages ?? 100;
        return newMessages.length > maxMessages ? newMessages.slice(-maxMessages) : newMessages;
      },
      currentResponse: () => "",
      sentenceIndex: () => 0,
      lastLLMResponse: ({ event }) => (event.type === "_llm:complete" ? event.fullText : ""),
    }),

    updateCurrentResponseFromEvent: assign({
      currentResponse: ({ context, event }) => {
        const token = event.type === "_llm:token" ? event.token : "";
        return context.currentResponse + token;
      },
    }),

    setIsSpeaking: assign({ isSpeaking: () => true }),
    clearIsSpeaking: assign({ isSpeaking: () => false }),
    setAITurnHadAudio: assign({ aiTurnHadAudio: () => true }),
    clearAITurnHadAudio: assign({ aiTurnHadAudio: () => false }),
    setHumanTurnStarted: assign({ humanTurnStarted: () => true }),
    clearHumanTurnStarted: assign({ humanTurnStarted: () => false }),
    setSpeechStartedAt: assign({ speechStartedAt: ({ context }) => now(context) }),
    clearSpeechStartedAt: assign({ speechStartedAt: () => null }),
    setPendingInterruptionStartedAt: assign({
      pendingInterruptionStartedAt: ({ context }) => now(context),
      pendingInterruptionCutoffEmitted: () => false,
    }),
    clearPendingInterruptionStartedAt: assign({ pendingInterruptionStartedAt: () => null }),
    setPendingInterruptionCutoffEmitted: assign({
      pendingInterruptionCutoffEmitted: () => true,
    }),
    clearPendingInterruptionCutoffEmitted: assign({
      pendingInterruptionCutoffEmitted: () => false,
    }),
    scheduleInterruptionConfirmation: assign({
      pendingInterruptionTimeoutId: ({ context, self }) =>
        setConfigTimeout(
          context.config,
          () => self.send({ type: "_interruption:confirm", timestamp: now(context) }),
          interruptionMinDuration(context),
        ),
    }),
    scheduleInterruptionCutoff: assign({
      pendingInterruptionCutoffTimeoutId: ({ context, self }) =>
        setConfigTimeout(
          context.config,
          () => self.send({ type: "_interruption:cutoff", timestamp: now(context) }),
          interruptionSpeculativeCutoffDelay(context),
        ),
    }),
    cancelInterruptionConfirmation: assign({
      pendingInterruptionTimeoutId: ({ context }) => {
        if (context.pendingInterruptionTimeoutId !== null) {
          clearConfigTimeout(context.config, context.pendingInterruptionTimeoutId);
        }
        return null;
      },
    }),
    cancelInterruptionCutoff: assign({
      pendingInterruptionCutoffTimeoutId: ({ context }) => {
        if (context.pendingInterruptionCutoffTimeoutId !== null) {
          clearConfigTimeout(context.config, context.pendingInterruptionCutoffTimeoutId);
        }
        return null;
      },
    }),
    clearCurrentResponse: assign({ currentResponse: () => "" }),
    createSessionAbortController: assign({ sessionAbortController: () => new AbortController() }),
    createTurnAbortController: assign({ turnAbortController: () => new AbortController() }),

    abortTurnController: ({ context }) => {
      context.turnAbortController?.abort();
    },

    abortSessionController: ({ context }) => {
      context.sessionAbortController?.abort();
    },

    createNewTurnAbortController: assign({
      turnAbortController: () => new AbortController(),
    }),

    clearDynamicActorRefs: assign({
      llmRef: () => null,
      ttsRef: () => null,
      activeTTSRequestId: () => null,
      sentenceQueue: () => [],
      pendingTTSCount: () => 0,
      pendingInterruptionStartedAt: () => null,
      pendingInterruptionTimeoutId: () => null,
      pendingInterruptionCutoffTimeoutId: () => null,
      pendingInterruptionCutoffEmitted: () => false,
    }),
    clearLLMRef: assign({ llmRef: () => null }),
    clearFillerTTS: assign({
      ttsRef: () => null,
      activeTTSRequestId: () => null,
      sentenceQueue: () => [],
      pendingTTSCount: () => 0,
    }),
    debugLogEvent: ({ context, event }) => {
      if (context.config.debug) {
        console.log("[machine] Event:", event.type);
      }
    },
    forwardAudioToSTT: sendTo("stt", ({ event }) => event),
    forwardAudioToVAD: sendTo("vad", ({ event }) => event),
    forwardToTurnDetector: sendTo("turnDetector", ({ event }) => event),
    forwardAudioToStreamer: sendTo("audioStreamer", ({ event }) => {
      if (event.type === "_tts:chunk") {
        return {
          type: "_audio:output-chunk" as const,
          audio: event.audio,
          timestamp: event.timestamp,
        };
      }
      return {
        type: "_audio:output-chunk" as const,
        audio: new ArrayBuffer(0),
        timestamp: event.timestamp,
      };
    }),
    spawnLLM: assign({
      llmRef: ({ context, spawn, self }) => {
        // Prevent duplicate LLM spawns
        if (context.llmRef !== null) {
          if (context.config.debug) {
            console.warn("[machine] LLM already running, skipping spawn");
          }
          return context.llmRef;
        }
        if (!context.turnAbortController) {
          throw new Error("[machine] Cannot spawn LLM: turnAbortController is null");
        }
        const signal = context.turnAbortController.signal;
        return spawn("llm", {
          input: {
            config: context.config,
            messages: context.messages,
            abortSignal: signal,
            sayFn: (text: string) =>
              self.send({ type: "_filler:say", text, timestamp: now(context) }),
            interruptFn: () => self.send({ type: "_filler:interrupt", timestamp: now(context) }),
            isSpeakingFn: () => self.getSnapshot().context.isSpeaking,
          },
        });
      },
    }),

    queueSentence: assign({
      sentenceQueue: ({ context, event }) => {
        const text = event.type === "_llm:sentence" ? event.sentence : "";
        return [...context.sentenceQueue, text];
      },
      pendingTTSCount: ({ context }) => context.pendingTTSCount + 1,
    }),

    spawnTTSFromQueue: assign(({ context, spawn }) => {
      const text = getTTSText("queue", context.sentenceQueue, { type: "" });
      if (!text) {
        return { ttsRef: null, activeTTSRequestId: null };
      }
      if (!context.turnAbortController) {
        throw new Error("[machine] Cannot spawn TTS: turnAbortController is null");
      }
      const signal = context.turnAbortController.signal;
      const requestId = nanoid();
      return {
        ttsRef: spawn("tts", {
          systemId: `currentTTS-${requestId}`,
          input: { config: context.config, text, requestId, abortSignal: signal },
        }),
        activeTTSRequestId: requestId,
        sentenceQueue: context.sentenceQueue.slice(1),
      };
    }),

    clearTTSRef: assign({ ttsRef: () => null, activeTTSRequestId: () => null }),

    decrementPendingTTS: assign({
      pendingTTSCount: ({ context }) => Math.max(0, context.pendingTTSCount - 1),
    }),

    spawnTTSFromFiller: assign(({ context, spawn, event }) => {
      const text = getTTSText("filler", [], event);
      if (!text) {
        return { ttsRef: null, activeTTSRequestId: null };
      }
      if (!context.turnAbortController) {
        throw new Error("[machine] Cannot spawn TTS from filler: turnAbortController is null");
      }
      const signal = context.turnAbortController.signal;
      const requestId = nanoid();
      return {
        ttsRef: spawn("tts", {
          systemId: `currentTTS-${requestId}`,
          input: { config: context.config, text, requestId, abortSignal: signal },
        }),
        activeTTSRequestId: requestId,
      };
    }),
    recordSessionStart: assign({
      metrics: ({ context }) => ({
        ...context.metrics,
        sessionStartedAt: now(context),
      }),
    }),
    recordHumanTurnStart: assign({
      metrics: ({ context }) => {
        if (context.metrics.humanTurnStartTime !== null) return context.metrics;
        return {
          ...context.metrics,
          humanTurnStartTime: now(context),
          totalTurns: context.metrics.totalTurns + 1,
        };
      },
    }),

    recordHumanTurnEnd: assign({
      metrics: ({ context, event }) => {
        const humanTurnEndTime = now(context);
        let speechDuration = context.metrics.humanSpeechDuration;
        if (event.type === "_vad:speech-end") {
          speechDuration = event.duration;
        } else if (context.metrics.humanTurnStartTime) {
          speechDuration = humanTurnEndTime - context.metrics.humanTurnStartTime;
        }

        let transcriptLength = 0;
        if (event.type === "_turn:end") {
          transcriptLength = event.transcript.length;
        } else if (event.type === "_stt:transcript" && event.isFinal) {
          transcriptLength = event.text.length;
        }

        return {
          ...context.metrics,
          humanTurnEndTime,
          humanSpeechDuration: speechDuration,
          humanTranscriptLength: transcriptLength,
          totalUserSpeechDuration: context.metrics.totalUserSpeechDuration + speechDuration,
          totalUserTranscriptChars: context.metrics.totalUserTranscriptChars + transcriptLength,
        };
      },
    }),

    recordHumanTurnAbandoned: assign({
      metrics: ({ context }) => ({
        ...context.metrics,
        abandonedTurns: context.metrics.abandonedTurns + 1,
      }),
    }),
    recordAITurnStart: assign({
      metrics: ({ context }) => ({
        ...context.metrics,
        aiTurnStartTime: now(context),
        currentTokenCount: 0,
        currentSentenceCount: 0,
        currentResponseLength: 0,
        currentAudioChunkCount: 0,
        currentAudioSamples: 0,
        firstTokenTime: null,
        firstSentenceTime: null,
        firstAudioTime: null,
        aiTurnEndTime: null,
      }),
    }),

    recordFirstToken: assign({
      metrics: ({ context }) => {
        if (context.metrics.firstTokenTime !== null) return context.metrics;
        return {
          ...context.metrics,
          firstTokenTime: now(context),
        };
      },
    }),

    recordToken: assign({
      metrics: ({ context, event }) => {
        const tokenLength = event.type === "_llm:token" ? event.token.length : 0;
        return {
          ...context.metrics,
          currentTokenCount: context.metrics.currentTokenCount + 1,
          currentResponseLength: context.metrics.currentResponseLength + tokenLength,
        };
      },
    }),
    recordResponseLengthFromComplete: assign({
      metrics: ({ context, event }) => {
        if (event.type !== "_llm:complete") return context.metrics;
        const responseLength = event.fullText.length;
        if (responseLength <= context.metrics.currentResponseLength) return context.metrics;
        return {
          ...context.metrics,
          currentResponseLength: responseLength,
        };
      },
    }),

    recordFirstSentence: assign({
      metrics: ({ context }) => {
        if (context.metrics.firstSentenceTime !== null) return context.metrics;
        return {
          ...context.metrics,
          firstSentenceTime: now(context),
        };
      },
    }),

    recordSentence: assign({
      metrics: ({ context }) => ({
        ...context.metrics,
        currentSentenceCount: context.metrics.currentSentenceCount + 1,
      }),
    }),

    recordFirstAudio: assign({
      metrics: ({ context }) => {
        if (context.metrics.firstAudioTime !== null) return context.metrics;
        return {
          ...context.metrics,
          firstAudioTime: now(context),
        };
      },
    }),

    recordAudioChunk: assign({
      metrics: ({ context, event }) => {
        const bytes = event.type === "_tts:chunk" ? event.audio.byteLength : 0;
        return {
          ...context.metrics,
          currentAudioChunkCount: context.metrics.currentAudioChunkCount + 1,
          currentAudioSamples: context.metrics.currentAudioSamples + bytes,
        };
      },
    }),

    recordAITurnComplete: assign({
      metrics: ({ context }) => {
        const aiTurnEndTime = now(context);
        const m = context.metrics;
        const timeToFirstToken =
          m.firstTokenTime && m.aiTurnStartTime ? m.firstTokenTime - m.aiTurnStartTime : 0;
        const timeToFirstAudio =
          m.firstAudioTime && m.aiTurnStartTime ? m.firstAudioTime - m.aiTurnStartTime : 0;
        const turnDuration = m.aiTurnStartTime ? aiTurnEndTime - m.aiTurnStartTime : 0;
        const speakingDuration = m.firstAudioTime ? aiTurnEndTime - m.firstAudioTime : 0;

        return {
          ...m,
          aiTurnEndTime,
          completedTurns: m.completedTurns + 1,
          completedTurnsForAverage: m.completedTurnsForAverage + 1,
          totalTimeToFirstToken: m.totalTimeToFirstToken + timeToFirstToken,
          totalTimeToFirstAudio: m.totalTimeToFirstAudio + timeToFirstAudio,
          totalTurnDuration: m.totalTurnDuration + turnDuration,
          totalLLMTokens: m.totalLLMTokens + m.currentTokenCount,
          totalResponseChars: m.totalResponseChars + m.currentResponseLength,
          totalAgentSpeakingDuration: m.totalAgentSpeakingDuration + speakingDuration,
          totalAudioChunks: m.totalAudioChunks + m.currentAudioChunkCount,
          totalAudioSamples: m.totalAudioSamples + m.currentAudioSamples,
        };
      },
    }),

    recordAITurnInterrupted: assign({
      metrics: ({ context }) => ({
        ...context.metrics,
        interruptedTurns: context.metrics.interruptedTurns + 1,
      }),
    }),

    recordError: assign({
      metrics: ({ context, event }) => {
        let source: "stt" | "llm" | "tts" | "vad" = "stt";
        if (event.type === "_llm:error") source = "llm";
        else if (event.type === "_tts:error") source = "tts";
        else if (event.type === "_vad:error") source = "vad";

        return {
          ...context.metrics,
          errorsBySource: {
            ...context.metrics.errorsBySource,
            [source]: context.metrics.errorsBySource[source] + 1,
          },
        };
      },
    }),
    warnSTTDegraded: ({ context }) => {
      if (context.config.debug) {
        console.warn("[machine] STT error - agent may not be able to transcribe audio");
      }
    },
    resetTurnMetrics: assign({
      metrics: ({ context }) => ({
        ...context.metrics,
        humanTurnStartTime: null,
        humanTurnEndTime: null,
        humanSpeechDuration: 0,
        humanTranscriptLength: 0,
        aiTurnStartTime: null,
        firstTokenTime: null,
        firstSentenceTime: null,
        firstAudioTime: null,
        aiTurnEndTime: null,
        currentTokenCount: 0,
        currentSentenceCount: 0,
        currentResponseLength: 0,
        currentAudioChunkCount: 0,
        currentAudioSamples: 0,
      }),
    }),
  },
});

export const agentMachine = agentMachineSetup.createMachine({
  id: "agent",
  initial: "idle",
  context: ({ input }) => createInitialContext(input.config, input.audioStreamController),

  states: {
    idle: {
      on: {
        "_agent:start": {
          target: "running",
          actions: [
            { type: "createSessionAbortController" },
            { type: "createTurnAbortController" },
            { type: "recordSessionStart" },
            { type: "emitAgentStarted" },
          ],
        },
      },
    },
    running: {
      type: "parallel",
      invoke: [
        {
          id: "stt",
          src: "stt",
          systemId: "stt",
          input: ({ context }) => {
            if (!context.sessionAbortController) {
              console.error(
                "[machine] sessionAbortController is null in STT invoke - this should never happen",
              );
            }
            return {
              config: context.config,
              abortSignal: context.sessionAbortController?.signal ?? new AbortController().signal,
            };
          },
        },
        {
          id: "vad",
          src: "vad",
          systemId: "vad",
          input: ({ context }) => {
            if (!context.sessionAbortController) {
              console.error(
                "[machine] sessionAbortController is null in VAD invoke - this should never happen",
              );
            }
            return {
              config: context.config,
              abortSignal: context.sessionAbortController?.signal ?? new AbortController().signal,
            };
          },
        },
        {
          id: "turnDetector",
          src: "turnDetector",
          systemId: "turnDetector",
          input: ({ context }) => {
            if (!context.sessionAbortController) {
              console.error(
                "[machine] sessionAbortController is null in turnDetector invoke - this should never happen",
              );
            }
            return {
              config: context.config,
              abortSignal: context.sessionAbortController?.signal ?? new AbortController().signal,
            };
          },
        },
        {
          id: "audioStreamer",
          src: "audioStreamer",
          systemId: "audioStreamer",
          input: ({ context }) => {
            if (!context.sessionAbortController) {
              console.error(
                "[machine] sessionAbortController is null in audioStreamer invoke - this should never happen",
              );
            }
            return {
              config: context.config,
              audioStreamController: context.audioStreamController,
              abortSignal: context.sessionAbortController?.signal ?? new AbortController().signal,
            };
          },
        },
      ],
      on: {
        "_agent:stop": { target: "#agent.stopped" },
        "_audio:input": {
          actions: [
            { type: "debugLogEvent" },
            { type: "forwardAudioToSTT" },
            { type: "forwardAudioToVAD" },
          ],
        },
        "_stt:error": {
          actions: [
            { type: "debugLogEvent" },
            { type: "recordError" },
            { type: "emitAgentError" },
            { type: "warnSTTDegraded" },
          ],
        },
        "_vad:error": {
          actions: [{ type: "debugLogEvent" }, { type: "recordError" }, { type: "emitAgentError" }],
        },
        "_llm:error": {
          actions: [
            { type: "debugLogEvent" },
            { type: "recordError" },
            { type: "emitAgentError" },
            { type: "abortTurnController" },
            { type: "createNewTurnAbortController" },
            { type: "clearDynamicActorRefs" },
            { type: "clearIsSpeaking" },
            { type: "clearCurrentResponse" },
            { type: "resetTurnMetrics" },
          ],
        },
        "_tts:error": {
          guard: "matchesActiveTTSRequest",
          actions: [{ type: "debugLogEvent" }, { type: "recordError" }, { type: "emitAgentError" }],
        },
        "_filler:say": {
          actions: [{ type: "setIsSpeaking" }, { type: "spawnTTSFromFiller" }],
        },
        "_filler:interrupt": {
          actions: [{ type: "clearFillerTTS" }, { type: "clearIsSpeaking" }],
        },
      },
      states: {
        listening: {
          initial: "idle",

          on: {
            "_interruption:cutoff": {
              guard: "shouldEmitPendingInterruption",
              actions: [
                { type: "debugLogEvent" },
                { type: "cancelInterruptionCutoff" },
                { type: "emitAITurnInterruptionPending" },
                { type: "setPendingInterruptionCutoffEmitted" },
              ],
            },
            "_interruption:confirm": {
              guard: "shouldConfirmPendingInterruption",
              target: ".userSpeaking",
              actions: [
                { type: "debugLogEvent" },
                { type: "cancelInterruptionCutoff" },
                { type: "recordAITurnInterrupted" },
                { type: "emitAITurnInterrupted" },
                { type: "abortTurnController" },
                { type: "createNewTurnAbortController" },
                { type: "clearDynamicActorRefs" },
                { type: "clearIsSpeaking" },
                { type: "clearAITurnHadAudio" },
                { type: "clearCurrentResponse" },
                { type: "clearPendingInterruptionStartedAt" },
                { type: "clearPendingInterruptionCutoffEmitted" },
                { type: "resetTurnMetrics" },
                { type: "recordHumanTurnStart" },
                { type: "setHumanTurnStarted" },
                { type: "emitHumanTurnStarted" },
              ],
            },
            "_vad:speech-start": [
              {
                guard: "shouldStartPendingInterruptionImmediately",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "setPendingInterruptionStartedAt" },
                  { type: "emitAITurnInterruptionPending" },
                  { type: "setPendingInterruptionCutoffEmitted" },
                  { type: "scheduleInterruptionConfirmation" },
                ],
              },
              {
                guard: "shouldStartPendingInterruption",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "setPendingInterruptionStartedAt" },
                  { type: "scheduleInterruptionCutoff" },
                  { type: "scheduleInterruptionConfirmation" },
                ],
              },
              {
                guard: "hasVADAdapter",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "recordHumanTurnStart" },
                  { type: "setHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                ],
              },
            ],
            "_stt:speech-start": [
              {
                guard: "shouldStartPendingSTTInterruptionImmediately",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "setSpeechStartedAt" },
                  { type: "setPendingInterruptionStartedAt" },
                  { type: "emitAITurnInterruptionPending" },
                  { type: "setPendingInterruptionCutoffEmitted" },
                  { type: "scheduleInterruptionConfirmation" },
                  { type: "recordHumanTurnStart" },
                ],
              },
              {
                guard: "shouldStartPendingSTTInterruption",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "setSpeechStartedAt" },
                  { type: "setPendingInterruptionStartedAt" },
                  { type: "scheduleInterruptionCutoff" },
                  { type: "scheduleInterruptionConfirmation" },
                  { type: "recordHumanTurnStart" },
                ],
              },
              {
                guard: "usesSTTForVAD",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "setSpeechStartedAt" },
                  { type: "recordHumanTurnStart" },
                ],
              },
            ],
          },

          states: {
            idle: {},
            userSpeaking: {
              on: {
                "_vad:speech-end": [
                  {
                    guard: "shouldInterruptOnPendingSpeechEnd",
                    target: "idle",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "cancelInterruptionCutoff" },
                      { type: "cancelInterruptionConfirmation" },
                      { type: "recordAITurnInterrupted" },
                      { type: "emitAITurnInterrupted" },
                      { type: "abortTurnController" },
                      { type: "createNewTurnAbortController" },
                      { type: "clearDynamicActorRefs" },
                      { type: "clearIsSpeaking" },
                      { type: "clearAITurnHadAudio" },
                      { type: "clearCurrentResponse" },
                      { type: "clearPendingInterruptionStartedAt" },
                      { type: "clearPendingInterruptionCutoffEmitted" },
                      { type: "resetTurnMetrics" },
                      { type: "recordHumanTurnStart" },
                      { type: "setHumanTurnStarted" },
                      { type: "emitHumanTurnStarted" },
                      { type: "forwardToTurnDetector" },
                    ],
                  },
                  {
                    guard: "shouldCancelEmittedPendingInterruption",
                    target: "idle",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "cancelInterruptionCutoff" },
                      { type: "cancelInterruptionConfirmation" },
                      { type: "emitAITurnInterruptionCancelled" },
                      { type: "clearPendingInterruptionStartedAt" },
                      { type: "clearPendingInterruptionCutoffEmitted" },
                    ],
                  },
                  {
                    guard: "hasPendingInterruption",
                    target: "idle",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "cancelInterruptionCutoff" },
                      { type: "cancelInterruptionConfirmation" },
                      { type: "clearPendingInterruptionStartedAt" },
                      { type: "clearPendingInterruptionCutoffEmitted" },
                    ],
                  },
                  {
                    guard: "hasVADAdapter",
                    target: "idle",
                    actions: [{ type: "forwardToTurnDetector" }],
                  },
                ],
                "_stt:speech-end": [
                  {
                    guard: "shouldCancelEmittedPendingInterruption",
                    target: "idle",
                    actions: [
                      { type: "clearSpeechStartedAt" },
                      { type: "cancelInterruptionCutoff" },
                      { type: "cancelInterruptionConfirmation" },
                      { type: "emitAITurnInterruptionCancelled" },
                      { type: "clearPendingInterruptionStartedAt" },
                      { type: "clearPendingInterruptionCutoffEmitted" },
                      { type: "forwardToTurnDetector" },
                    ],
                  },
                  {
                    guard: "hasPendingInterruption",
                    target: "idle",
                    actions: [
                      { type: "clearSpeechStartedAt" },
                      { type: "cancelInterruptionCutoff" },
                      { type: "cancelInterruptionConfirmation" },
                      { type: "clearPendingInterruptionStartedAt" },
                      { type: "clearPendingInterruptionCutoffEmitted" },
                      { type: "forwardToTurnDetector" },
                    ],
                  },
                  {
                    guard: "usesSTTForVAD",
                    target: "idle",
                    actions: [{ type: "clearSpeechStartedAt" }, { type: "forwardToTurnDetector" }],
                  },
                ],
              },
            },
          },
        },
        transcribing: {
          on: {
            "_stt:transcript": [
              {
                guard: "canInterruptFromSTT",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "cancelInterruptionCutoff" },
                  { type: "cancelInterruptionConfirmation" },
                  { type: "recordAITurnInterrupted" },
                  { type: "emitAITurnInterrupted" },
                  { type: "abortTurnController" },
                  { type: "createNewTurnAbortController" },
                  { type: "clearDynamicActorRefs" },
                  { type: "clearIsSpeaking" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearCurrentResponse" },
                  { type: "clearSpeechStartedAt" },
                  { type: "clearPendingInterruptionStartedAt" },
                  { type: "clearPendingInterruptionCutoffEmitted" },
                  { type: "resetTurnMetrics" },
                  { type: "setHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                  { type: "recordHumanTurnStart" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "updatePartialTranscriptFromEvent" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: ({ event, context }) =>
                  event.type === "_stt:transcript" && !event.isFinal && !context.humanTurnStarted,
                actions: [
                  { type: "setHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                  { type: "recordHumanTurnStart" },
                  { type: "debugLogEvent" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "updatePartialTranscriptFromEvent" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: ({ event }) => event.type === "_stt:transcript" && !event.isFinal,
                actions: [
                  { type: "debugLogEvent" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "updatePartialTranscriptFromEvent" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: ({ event, context }) =>
                  event.type === "_stt:transcript" &&
                  event.isFinal &&
                  !context.humanTurnStarted &&
                  context.turnSource === "adapter",
                actions: [
                  { type: "setHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                  { type: "recordHumanTurnStart" },
                  { type: "debugLogEvent" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: ({ event, context }) =>
                  event.type === "_stt:transcript" &&
                  event.isFinal &&
                  context.turnSource === "adapter",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: ({ event, context }) =>
                  event.type === "_stt:transcript" &&
                  event.isFinal &&
                  !context.humanTurnStarted &&
                  context.turnSource === "stt" &&
                  context.vadSource === "stt" &&
                  (context.config.interruption?.enabled ?? false) &&
                  hasActiveAITurnContext(context),
                actions: [
                  { type: "setHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                  { type: "recordHumanTurnStart" },
                  { type: "debugLogEvent" },
                  { type: "recordHumanTurnEnd" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromSTT" },
                  { type: "cancelInterruptionCutoff" },
                  { type: "cancelInterruptionConfirmation" },
                  { type: "recordAITurnInterrupted" },
                  { type: "emitAITurnInterrupted" },
                  { type: "abortTurnController" },
                  { type: "createNewTurnAbortController" },
                  { type: "clearDynamicActorRefs" },
                  { type: "clearIsSpeaking" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearCurrentResponse" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "clearPendingInterruptionStartedAt" },
                  { type: "clearPendingInterruptionCutoffEmitted" },
                  { type: "resetTurnMetrics" },
                  { type: "recordAITurnStart" },
                  { type: "emitAITurnStarted" },
                  { type: "spawnLLM" },
                ],
              },
              {
                guard: ({ event, context }) =>
                  event.type === "_stt:transcript" &&
                  event.isFinal &&
                  context.turnSource === "stt" &&
                  context.vadSource === "stt" &&
                  (context.config.interruption?.enabled ?? false) &&
                  hasActiveAITurnContext(context),
                actions: [
                  { type: "debugLogEvent" },
                  { type: "recordHumanTurnEnd" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromSTT" },
                  { type: "cancelInterruptionCutoff" },
                  { type: "cancelInterruptionConfirmation" },
                  { type: "recordAITurnInterrupted" },
                  { type: "emitAITurnInterrupted" },
                  { type: "abortTurnController" },
                  { type: "createNewTurnAbortController" },
                  { type: "clearDynamicActorRefs" },
                  { type: "clearIsSpeaking" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearCurrentResponse" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "clearPendingInterruptionStartedAt" },
                  { type: "clearPendingInterruptionCutoffEmitted" },
                  { type: "resetTurnMetrics" },
                  { type: "recordAITurnStart" },
                  { type: "emitAITurnStarted" },
                  { type: "spawnLLM" },
                ],
              },
              {
                guard: ({ event, context }) =>
                  event.type === "_stt:transcript" &&
                  event.isFinal &&
                  !context.humanTurnStarted &&
                  context.turnSource === "stt" &&
                  !hasActiveAITurnContext(context),
                actions: [
                  { type: "setHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                  { type: "recordHumanTurnStart" },
                  { type: "debugLogEvent" },
                  { type: "recordHumanTurnEnd" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromSTT" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "recordAITurnStart" },
                  { type: "emitAITurnStarted" },
                  { type: "spawnLLM" },
                ],
              },
              {
                guard: ({ event, context }) =>
                  event.type === "_stt:transcript" &&
                  event.isFinal &&
                  context.turnSource === "stt" &&
                  !hasActiveAITurnContext(context),
                actions: [
                  { type: "debugLogEvent" },
                  { type: "recordHumanTurnEnd" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromSTT" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "recordAITurnStart" },
                  { type: "emitAITurnStarted" },
                  { type: "spawnLLM" },
                ],
              },
            ],
            "_vad:probability": {
              actions: [{ type: "emitVADProbability" }],
            },
            "_turn:end": [
              {
                guard: "hasActiveAITurn",
                actions: [
                  { type: "recordHumanTurnEnd" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromTurnEnd" },
                  { type: "recordAITurnInterrupted" },
                  { type: "emitAITurnInterrupted" },
                  { type: "abortTurnController" },
                  { type: "createNewTurnAbortController" },
                  { type: "clearDynamicActorRefs" },
                  { type: "clearIsSpeaking" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearCurrentResponse" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "resetTurnMetrics" },
                  { type: "recordAITurnStart" },
                  { type: "emitAITurnStarted" },
                  { type: "spawnLLM" },
                ],
              },
              {
                actions: [
                  { type: "recordHumanTurnEnd" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromTurnEnd" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "recordAITurnStart" },
                  { type: "emitAITurnStarted" },
                  { type: "spawnLLM" },
                ],
              },
            ],
            "_turn:abandoned": {
              actions: [
                { type: "recordHumanTurnAbandoned" },
                { type: "emitHumanTurnAbandoned" },
                { type: "clearHumanTurnStarted" },
                { type: "clearSpeechStartedAt" },
              ],
            },
          },
        },
        responding: {
          initial: "idle",
          states: {
            idle: {},
            generating: {},
          },
          on: {
            "_llm:token": {
              actions: [
                { type: "recordFirstToken" },
                { type: "recordToken" },
                { type: "emitAITurnToken" },
                { type: "updateCurrentResponseFromEvent" },
              ],
            },
            "_llm:sentence": [
              {
                guard: ({ context }) => context.ttsRef === null,
                actions: [
                  { type: "recordFirstSentence" },
                  { type: "recordSentence" },
                  { type: "emitAITurnSentence" },
                  { type: "setIsSpeaking" },
                  { type: "queueSentence" },
                  { type: "spawnTTSFromQueue" },
                ],
              },
              {
                actions: [
                  { type: "recordFirstSentence" },
                  { type: "recordSentence" },
                  { type: "emitAITurnSentence" },
                  { type: "queueSentence" },
                ],
              },
            ],
            "_llm:complete": [
              {
                guard: "aiTurnHadNoAudio",
                actions: [
                  { type: "clearLLMRef" },
                  { type: "recordResponseLengthFromComplete" },
                  { type: "recordAITurnComplete" },
                  { type: "emitAITurnEnded" },
                  { type: "addAssistantMessageFromEvent" },
                  { type: "resetTurnMetrics" },
                ],
              },
              {
                actions: [
                  { type: "clearLLMRef" },
                  { type: "recordResponseLengthFromComplete" },
                  { type: "addAssistantMessageFromEvent" },
                ],
              },
            ],
          },
        },
        streaming: {
          initial: "silent",
          states: {
            silent: {
              on: {
                "_tts:chunk": {
                  guard: "speakingCurrentTTS",
                  target: "streaming",
                  actions: [
                    { type: "setAITurnHadAudio" },
                    { type: "recordFirstAudio" },
                    { type: "recordAudioChunk" },
                    { type: "emitAITurnAudio" },
                    { type: "forwardAudioToStreamer" },
                  ],
                },
                "_tts:complete": [
                  {
                    guard: "hasPendingSentencesForCurrentTTS",
                    actions: [
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "spawnTTSFromQueue" },
                    ],
                  },
                  {
                    guard: "matchesActiveTTSRequest",
                    actions: [
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "clearIsSpeaking" },
                    ],
                  },
                ],
                "_tts:error": [
                  {
                    guard: "hasPendingSentencesForCurrentTTS",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "recordError" },
                      { type: "emitAgentError" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "spawnTTSFromQueue" },
                    ],
                  },
                  {
                    guard: "matchesActiveTTSRequest",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "recordError" },
                      { type: "emitAgentError" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "clearIsSpeaking" },
                    ],
                  },
                ],
              },
            },
            streaming: {
              on: {
                "_tts:chunk": {
                  guard: "speakingCurrentTTS",
                  actions: [
                    { type: "recordAudioChunk" },
                    { type: "emitAITurnAudio" },
                    { type: "forwardAudioToStreamer" },
                  ],
                },
                "_tts:complete": [
                  {
                    guard: "hasPendingSentencesForCurrentTTS",
                    actions: [
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "spawnTTSFromQueue" },
                    ],
                  },
                  {
                    guard: "matchesActiveTTSRequest",
                    target: "silent",
                    actions: [
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "recordAITurnComplete" },
                      { type: "clearIsSpeaking" },
                      { type: "emitAITurnEnded" },
                      { type: "resetTurnMetrics" },
                    ],
                  },
                ],
                "_tts:error": [
                  {
                    guard: "hasPendingSentencesForCurrentTTS",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "recordError" },
                      { type: "emitAgentError" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "spawnTTSFromQueue" },
                    ],
                  },
                  {
                    guard: "matchesActiveTTSRequest",
                    target: "silent",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "recordError" },
                      { type: "emitAgentError" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "recordAITurnComplete" },
                      { type: "clearIsSpeaking" },
                      { type: "emitAITurnEnded" },
                      { type: "resetTurnMetrics" },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    stopped: {
      entry: [
        { type: "abortSessionController" },
        { type: "abortTurnController" },
        { type: "emitAgentStopped" },
      ],
      type: "final",
    },
  },
  output: ({ context }) => ({
    messages: context.messages,
    turnCount: context.messages.filter((m) => m.role === "user").length,
  }),
});

export type AgentMachine = typeof agentMachine;
