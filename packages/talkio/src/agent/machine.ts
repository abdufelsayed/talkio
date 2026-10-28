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
import { trace } from "./trace";

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

function transcriptWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasMeaningfulInterimTranscript(
  context: AgentMachineContext,
  event: MachineEvent,
): boolean {
  if (event.type !== "_stt:transcript" || event.isFinal) return false;
  const text = event.text.trim();
  if (!text) return false;
  const minChars = context.config.interruption?.interimMinChars ?? 3;
  const minWords = context.config.interruption?.interimMinWords ?? 2;
  return text.length >= minChars && transcriptWordCount(text) >= minWords;
}

function hasActiveAITurnContext(context: AgentMachineContext): boolean {
  return (
    context.llmRef !== null || context.activeTTSRequestId !== null || context.pendingTTSCount > 0
  );
}

function generatedResponse(context: AgentMachineContext): string {
  return context.currentResponse || context.lastLLMResponse;
}

function canCompleteAITurnAfterLLMComplete(context: AgentMachineContext): boolean {
  return (
    !context.aiTurnTerminalEmitted &&
    context.activeTTSRequestId === null &&
    context.pendingTTSCount === 0 &&
    context.sentenceQueue.length === 0
  );
}

function canCompleteAITurnAfterCurrentTTS(
  context: AgentMachineContext,
  event: MachineEvent,
): boolean {
  if (event.type !== "_tts:complete" && event.type !== "_tts:error") return false;
  if (context.activeTTSRequestId === null || event.requestId !== context.activeTTSRequestId) {
    return false;
  }
  return (
    !context.aiTurnTerminalEmitted &&
    context.llmCompleted &&
    context.pendingTTSCount <= 1 &&
    context.sentenceQueue.length === 0
  );
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
    shouldSpeculativelyCutFromSTTInterimBeforeHumanTurn: ({ context, event }) =>
      !context.humanTurnStarted &&
      !context.pendingInterruptionCutoffEmitted &&
      (context.config.interruption?.enabled ?? false) &&
      hasActiveAITurnContext(context) &&
      hasMeaningfulInterimTranscript(context, event),
    shouldSpeculativelyCutFromSTTInterim: ({ context, event }) =>
      !context.pendingInterruptionCutoffEmitted &&
      (context.config.interruption?.enabled ?? false) &&
      hasActiveAITurnContext(context) &&
      hasMeaningfulInterimTranscript(context, event),

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
    canCompleteAITurnAfterLLMComplete: ({ context }) => canCompleteAITurnAfterLLMComplete(context),
    canCompleteAITurnAfterCurrentTTS: ({ context, event }) =>
      canCompleteAITurnAfterCurrentTTS(context, event),
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
      turnId: context.currentHumanTurnId ?? undefined,
      timestamp: now(context),
    })),
    emitHumanTurnTranscript: emit(({ context, event }) => {
      if (event.type === "_stt:transcript") {
        return {
          type: "human-turn:transcript" as const,
          turnId: context.currentHumanTurnId ?? undefined,
          text: event.text,
          isFinal: event.isFinal,
          timestamp: now(context),
        };
      }
      return {
        type: "human-turn:transcript" as const,
        turnId: context.currentHumanTurnId ?? undefined,
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
        turnId: context.currentHumanTurnId ?? undefined,
        transcript,
        metrics: buildHumanTurnMetrics(context.metrics),
        timestamp: now(context),
      };
    }),
    emitHumanTurnAbandoned: emit(({ context, event }) => {
      const reason = event.type === "_turn:abandoned" ? event.reason : "unknown";
      return {
        type: "human-turn:abandoned" as const,
        turnId: context.currentHumanTurnId ?? undefined,
        reason,
        timestamp: now(context),
      };
    }),
    emitAITurnStarted: emit(({ context }) => ({
      type: "ai-turn:started" as const,
      turnId: context.currentAITurnId ?? undefined,
      timestamp: now(context),
    })),
    emitAITurnToken: emit(({ context, event }) => {
      const token = event.type === "_llm:token" ? event.token : "";
      return {
        type: "ai-turn:token" as const,
        turnId: context.currentAITurnId ?? undefined,
        token,
        timestamp: now(context),
      };
    }),
    emitAITurnSentence: emit(({ context, event }) => {
      if (event.type === "_llm:sentence") {
        return {
          type: "ai-turn:sentence" as const,
          turnId: context.currentAITurnId ?? undefined,
          sentence: event.sentence,
          index: event.index,
          timestamp: now(context),
        };
      }
      return {
        type: "ai-turn:sentence" as const,
        turnId: context.currentAITurnId ?? undefined,
        sentence: "",
        index: 0,
        timestamp: now(context),
      };
    }),
    emitAITurnAudio: emit(({ context, event }) => {
      const audio = event.type === "_tts:chunk" ? event.audio : new ArrayBuffer(0);
      return {
        type: "ai-turn:audio" as const,
        turnId: context.currentAITurnId ?? undefined,
        requestId: context.activeTTSRequestId ?? undefined,
        audio,
        timestamp: now(context),
      };
    }),
    emitAITurnEnded: emit(({ context }) => ({
      type: "ai-turn:ended" as const,
      turnId: context.currentAITurnId ?? undefined,
      text: context.lastLLMResponse,
      wasSpoken: context.aiTurnHadAudio,
      metrics: buildAITurnMetrics(context.metrics, false, now(context)),
      timestamp: now(context),
    })),
    emitAITurnInterrupted: emit(({ context }) => ({
      type: "ai-turn:interrupted" as const,
      turnId: context.currentAITurnId ?? undefined,
      partialText: generatedResponse(context),
      generatedText: generatedResponse(context),
      audioStartedText: context.audioStartedResponse,
      audioCompletedText: context.audioCompletedResponse,
      spokenText: context.audioCompletedResponse,
      metrics: buildAITurnMetrics(context.metrics, true, now(context)),
      timestamp: now(context),
    })),
    emitAITurnInterruptionPending: emit(({ context }) => ({
      type: "ai-turn:interruption-pending" as const,
      turnId: context.currentAITurnId ?? undefined,
      partialText: generatedResponse(context),
      timestamp: now(context),
    })),
    emitAITurnInterruptionCancelled: emit(({ context }) => ({
      type: "ai-turn:interruption-cancelled" as const,
      turnId: context.currentAITurnId ?? undefined,
      partialText: generatedResponse(context),
      timestamp: now(context),
    })),
    emitAudioClear: emit(({ context }) => ({
      type: "audio:clear" as const,
      turnId: context.currentAITurnId ?? undefined,
      requestId: context.activeTTSRequestId ?? undefined,
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

    addAssistantMessageFromStoredResponse: assign({
      messages: ({ context }) => {
        const fullText = context.lastLLMResponse;
        const newMessages = [
          ...context.messages,
          { role: "assistant" as const, content: fullText },
        ];
        const maxMessages = context.config.maxMessages ?? 100;
        return newMessages.length > maxMessages ? newMessages.slice(-maxMessages) : newMessages;
      },
    }),

    storeLLMCompleteFromEvent: assign({
      lastLLMResponse: ({ event }) => (event.type === "_llm:complete" ? event.fullText : ""),
      currentResponse: ({ context, event }) => {
        if (event.type !== "_llm:complete") return context.currentResponse;
        return context.currentResponse || event.fullText;
      },
      llmCompleted: ({ event, context }) =>
        event.type === "_llm:complete" ? true : context.llmCompleted,
    }),

    markAITurnTerminalEmitted: assign({
      aiTurnTerminalEmitted: () => true,
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
    setHumanTurnStarted: assign({
      humanTurnStarted: () => true,
      currentHumanTurnId: ({ context }) => context.currentHumanTurnId ?? nanoid(),
    }),
    clearHumanTurnStarted: assign({
      humanTurnStarted: () => false,
      currentHumanTurnId: () => null,
    }),
    setSpeechStartedAt: assign({ speechStartedAt: ({ context }) => now(context) }),
    clearSpeechStartedAt: assign({ speechStartedAt: () => null }),
    setPendingInterruptionStartedAt: assign({
      pendingInterruptionStartedAt: ({ context }) => now(context),
      pendingInterruptionCutoffEmitted: () => false,
    }),
    setPendingInterruptionStartedAtIfUnset: assign({
      pendingInterruptionStartedAt: ({ context }) =>
        context.pendingInterruptionStartedAt ?? now(context),
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
    clearAITurnResponseState: assign({
      currentResponse: () => "",
      lastLLMResponse: () => "",
      audioStartedResponse: () => "",
      audioCompletedResponse: () => "",
      sentenceIndex: () => 0,
      currentAITurnId: () => null,
      llmCompleted: () => false,
    }),
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
      activeTTSRequestText: () => null,
      audioStartedTTSRequestIds: () => [],
      audioCompletedTTSRequestIds: () => [],
      sentenceQueue: () => [],
      pendingTTSCount: () => 0,
      pendingInterruptionStartedAt: () => null,
      pendingInterruptionTimeoutId: () => null,
      pendingInterruptionCutoffTimeoutId: () => null,
      pendingInterruptionCutoffEmitted: () => false,
      llmCompleted: () => false,
    }),
    clearLLMRef: assign({ llmRef: () => null }),
    clearFillerTTS: assign({
      ttsRef: () => null,
      activeTTSRequestId: () => null,
      activeTTSRequestText: () => null,
      sentenceQueue: () => [],
      pendingTTSCount: () => 0,
    }),
    debugLogEvent: ({ context, event }) => {
      if (context.config.debug) {
        if (event.type === "_audio:input") return;
        console.log("[machine] Event:", event.type);
      }
    },
    traceAgentStarted: ({ context }) => {
      trace(context.config, { type: "agent:started" });
    },
    traceAgentStopped: ({ context }) => {
      trace(context.config, { type: "agent:stopped" });
    },
    traceAudioInput: ({ context, event }) => {
      if (event.type !== "_audio:input") return;
      trace(context.config, {
        type: "audio:input",
        data: { bytes: event.audio.byteLength },
      });
    },
    traceSpeechStarted: ({ context, event }) => {
      if (event.type !== "_vad:speech-start" && event.type !== "_stt:speech-start") return;
      trace(context.config, {
        type: "speech:start",
        turnId: context.currentAITurnId ?? undefined,
        data: {
          source: event.type === "_vad:speech-start" ? "vad" : "stt",
          speaking: context.isSpeaking,
          audioStarted: context.aiTurnHadAudio,
        },
      });
    },
    traceInterimSpeechStarted: ({ context, event }) => {
      if (event.type !== "_stt:transcript" || event.isFinal) return;
      trace(context.config, {
        type: "speech:start",
        turnId: context.currentAITurnId ?? undefined,
        data: {
          source: "stt-interim",
          speaking: context.isSpeaking,
          audioStarted: context.aiTurnHadAudio,
          transcriptLength: event.text.length,
          words: transcriptWordCount(event.text),
        },
      });
    },
    traceSpeechEnded: ({ context, event }) => {
      if (event.type !== "_vad:speech-end" && event.type !== "_stt:speech-end") return;
      trace(context.config, {
        type: "speech:end",
        turnId: context.currentAITurnId ?? undefined,
        data: {
          source: event.type === "_vad:speech-end" ? "vad" : "stt",
          speaking: context.isSpeaking,
          audioStarted: context.aiTurnHadAudio,
          duration: event.type === "_vad:speech-end" ? event.duration : undefined,
        },
      });
    },
    traceHumanTurnStarted: ({ context }) => {
      trace(context.config, {
        type: "human-turn:started",
        turnId: context.currentHumanTurnId ?? undefined,
      });
    },
    traceHumanTurnEnded: ({ context, event }) => {
      const transcript =
        event.type === "_turn:end"
          ? event.transcript
          : event.type === "_stt:transcript" && event.isFinal
            ? event.text
            : "";
      trace(context.config, {
        type: "human-turn:ended",
        turnId: context.currentHumanTurnId ?? undefined,
        data: { length: transcript.length, preview: transcript.slice(0, 120) },
      });
    },
    traceAITurnStarted: ({ context }) => {
      trace(context.config, {
        type: "ai-turn:started",
        turnId: context.currentAITurnId ?? undefined,
      });
    },
    traceAITurnSentence: ({ context, event }) => {
      if (event.type !== "_llm:sentence") return;
      trace(context.config, {
        type: "ai-turn:sentence-queued",
        turnId: context.currentAITurnId ?? undefined,
        data: {
          index: event.index,
          queueDepth: context.sentenceQueue.length + 1,
          length: event.sentence.length,
          preview: event.sentence.slice(0, 120),
        },
      });
    },
    traceAITurnAudio: ({ context, event }) => {
      if (event.type !== "_tts:chunk") return;
      trace(context.config, {
        type: "ai-turn:audio",
        turnId: context.currentAITurnId ?? undefined,
        requestId: context.activeTTSRequestId ?? undefined,
        data: { bytes: event.audio.byteLength },
      });
    },
    traceAITurnEnded: ({ context }) => {
      trace(context.config, {
        type: "ai-turn:ended",
        turnId: context.currentAITurnId ?? undefined,
        elapsedMs: context.metrics.aiTurnStartTime
          ? now(context) - context.metrics.aiTurnStartTime
          : 0,
        data: {
          wasSpoken: context.aiTurnHadAudio,
          length: context.lastLLMResponse.length,
          audioChunks: context.metrics.currentAudioChunkCount,
        },
      });
    },
    traceAITurnInterrupted: ({ context }) => {
      trace(context.config, {
        type: "ai-turn:interrupted",
        turnId: context.currentAITurnId ?? undefined,
        elapsedMs: context.metrics.aiTurnStartTime
          ? now(context) - context.metrics.aiTurnStartTime
          : 0,
        data: {
          partialLength: generatedResponse(context).length,
          audioStartedLength: context.audioStartedResponse.length,
          audioCompletedLength: context.audioCompletedResponse.length,
          audioChunks: context.metrics.currentAudioChunkCount,
        },
      });
    },
    traceInterruptionPending: ({ context }) => {
      trace(context.config, {
        type: "interruption:pending",
        turnId: context.currentAITurnId ?? undefined,
        data: {
          partialLength: generatedResponse(context).length,
          audioStarted: context.aiTurnHadAudio,
          audioStartedLength: context.audioStartedResponse.length,
          audioCompletedLength: context.audioCompletedResponse.length,
        },
      });
    },
    traceInterruptionCancelled: ({ context }) => {
      trace(context.config, {
        type: "interruption:cancelled",
        turnId: context.currentAITurnId ?? undefined,
        data: {
          partialLength: generatedResponse(context).length,
          audioStarted: context.aiTurnHadAudio,
          audioStartedLength: context.audioStartedResponse.length,
          audioCompletedLength: context.audioCompletedResponse.length,
        },
      });
    },
    traceTTSQueueState: ({ context }) => {
      trace(context.config, {
        type: "tts:queue",
        turnId: context.currentAITurnId ?? undefined,
        requestId: context.activeTTSRequestId ?? undefined,
        data: {
          queueDepth: context.sentenceQueue.length,
          pendingTTSCount: context.pendingTTSCount,
          isSpeaking: context.isSpeaking,
        },
      });
    },
    forwardAudioToSTT: sendTo("stt", ({ event }) => event),
    forwardAudioToVAD: sendTo("vad", ({ event }) => event),
    forwardToTurnDetector: sendTo("turnDetector", ({ event }) => event),
    forwardAudioToStreamer: sendTo("audioStreamer", ({ context, event }) => {
      if (event.type === "_tts:chunk") {
        return {
          type: "_audio:output-chunk" as const,
          audio: event.audio,
          turnId: context.currentAITurnId ?? undefined,
          requestId: context.activeTTSRequestId ?? undefined,
          timestamp: event.timestamp,
        };
      }
      return {
        type: "_audio:output-chunk" as const,
        audio: new ArrayBuffer(0),
        turnId: context.currentAITurnId ?? undefined,
        requestId: context.activeTTSRequestId ?? undefined,
        timestamp: event.timestamp,
      };
    }),
    clearAudioStreamer: sendTo("audioStreamer", ({ context }) => ({
      type: "_audio:output-clear" as const,
      turnId: context.currentAITurnId ?? undefined,
      requestId: context.activeTTSRequestId ?? undefined,
      timestamp: now(context),
    })),
    clearTTSProvider: sendTo("tts", ({ context }) => ({
      type: "_tts:clear" as const,
      requestId: context.activeTTSRequestId ?? undefined,
      timestamp: now(context),
    })),
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
            turnId: context.currentAITurnId,
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

    spawnTTSFromQueue: assign(({ context }) => {
      const text = getTTSText("queue", context.sentenceQueue, { type: "" });
      if (!text) {
        return { ttsRef: null, activeTTSRequestId: null };
      }
      if (!context.turnAbortController) {
        throw new Error("[machine] Cannot spawn TTS: turnAbortController is null");
      }
      const requestId = nanoid();
      return {
        ttsRef: null,
        activeTTSRequestId: requestId,
        activeTTSRequestText: text,
        sentenceQueue: context.sentenceQueue.slice(1),
      };
    }),
    sendActiveTTSRequest: sendTo("tts", ({ context }) => ({
      type: "_tts:speak" as const,
      requestId: context.activeTTSRequestId ?? "",
      turnId: context.currentAITurnId ?? undefined,
      text: context.activeTTSRequestText ?? "",
      timestamp: now(context),
    })),

    clearTTSRef: assign({
      ttsRef: () => null,
      activeTTSRequestId: () => null,
      activeTTSRequestText: () => null,
    }),

    decrementPendingTTS: assign({
      pendingTTSCount: ({ context }) => Math.max(0, context.pendingTTSCount - 1),
    }),
    cancelActiveTTSRequest: assign({
      ttsRef: () => null,
      activeTTSRequestId: () => null,
      activeTTSRequestText: () => null,
      pendingTTSCount: ({ context }) =>
        context.activeTTSRequestId === null
          ? context.pendingTTSCount
          : Math.max(0, context.pendingTTSCount - 1),
    }),

    spawnTTSFromFiller: assign(({ context, event }) => {
      const text = getTTSText("filler", [], event);
      if (!text) {
        return { ttsRef: null, activeTTSRequestId: null };
      }
      if (!context.turnAbortController) {
        throw new Error("[machine] Cannot spawn TTS from filler: turnAbortController is null");
      }
      const requestId = nanoid();
      return {
        ttsRef: null,
        activeTTSRequestId: requestId,
        activeTTSRequestText: text,
      };
    }),
    recordAudioStartedTextFromCurrentTTS: assign({
      audioStartedResponse: ({ context, event }) => {
        if (event.type !== "_tts:chunk") return context.audioStartedResponse;
        if (event.requestId !== context.activeTTSRequestId) return context.audioStartedResponse;
        if (!context.activeTTSRequestText) return context.audioStartedResponse;
        if (context.audioStartedTTSRequestIds.includes(event.requestId)) {
          return context.audioStartedResponse;
        }
        return [context.audioStartedResponse, context.activeTTSRequestText]
          .filter(Boolean)
          .join(" ")
          .trim();
      },
      audioStartedTTSRequestIds: ({ context, event }) => {
        if (event.type !== "_tts:chunk") return context.audioStartedTTSRequestIds;
        if (event.requestId !== context.activeTTSRequestId) {
          return context.audioStartedTTSRequestIds;
        }
        if (!context.activeTTSRequestText) return context.audioStartedTTSRequestIds;
        if (context.audioStartedTTSRequestIds.includes(event.requestId)) {
          return context.audioStartedTTSRequestIds;
        }
        return [...context.audioStartedTTSRequestIds, event.requestId];
      },
    }),
    recordAudioCompletedTextFromCurrentTTS: assign({
      audioCompletedResponse: ({ context, event }) => {
        if (event.type !== "_tts:complete") return context.audioCompletedResponse;
        if (event.requestId !== context.activeTTSRequestId) return context.audioCompletedResponse;
        if (!context.activeTTSRequestText) return context.audioCompletedResponse;
        if (context.audioCompletedTTSRequestIds.includes(event.requestId)) {
          return context.audioCompletedResponse;
        }
        return [context.audioCompletedResponse, context.activeTTSRequestText]
          .filter(Boolean)
          .join(" ")
          .trim();
      },
      audioCompletedTTSRequestIds: ({ context, event }) => {
        if (event.type !== "_tts:complete") return context.audioCompletedTTSRequestIds;
        if (event.requestId !== context.activeTTSRequestId) {
          return context.audioCompletedTTSRequestIds;
        }
        if (!context.activeTTSRequestText) return context.audioCompletedTTSRequestIds;
        if (context.audioCompletedTTSRequestIds.includes(event.requestId)) {
          return context.audioCompletedTTSRequestIds;
        }
        return [...context.audioCompletedTTSRequestIds, event.requestId];
      },
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
      currentAITurnId: () => nanoid(),
      currentResponse: () => "",
      lastLLMResponse: () => "",
      audioStartedResponse: () => "",
      audioCompletedResponse: () => "",
      audioStartedTTSRequestIds: () => [],
      audioCompletedTTSRequestIds: () => [],
      sentenceIndex: () => 0,
      llmCompleted: () => false,
      aiTurnTerminalEmitted: () => false,
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
      messages: ({ context, event }) => {
        const completedText = context.audioCompletedResponse.trim();
        if (!completedText) return context.messages;
        const assistantMessage = { role: "assistant" as const, content: completedText };
        const lastMessage = context.messages.at(-1);
        if (lastMessage?.role === "assistant" && lastMessage.content === completedText) {
          return context.messages;
        }

        let newMessages = [...context.messages, assistantMessage];
        if (
          event.type === "_stt:transcript" &&
          event.isFinal &&
          lastMessage?.role === "user" &&
          lastMessage.content === event.text
        ) {
          newMessages = [...context.messages.slice(0, -1), assistantMessage, lastMessage];
        } else if (
          event.type === "_turn:end" &&
          lastMessage?.role === "user" &&
          lastMessage.content === event.transcript
        ) {
          newMessages = [...context.messages.slice(0, -1), assistantMessage, lastMessage];
        }

        const maxMessages = context.config.maxMessages ?? 100;
        return newMessages.length > maxMessages ? newMessages.slice(-maxMessages) : newMessages;
      },
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
            { type: "traceAgentStarted" },
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
          id: "tts",
          src: "tts",
          systemId: "tts",
          input: ({ context }) => {
            if (!context.sessionAbortController) {
              console.error(
                "[machine] sessionAbortController is null in TTS invoke - this should never happen",
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
              debug: context.config.debug,
            };
          },
        },
      ],
      on: {
        "_agent:stop": { target: "#agent.stopped" },
        "_audio:input": {
          actions: [
            { type: "debugLogEvent" },
            { type: "traceAudioInput" },
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
            { type: "clearTTSProvider" },
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
          actions: [
            { type: "setIsSpeaking" },
            { type: "spawnTTSFromFiller" },
            { type: "sendActiveTTSRequest" },
          ],
        },
        "_filler:interrupt": {
          actions: [
            { type: "clearTTSProvider" },
            { type: "clearFillerTTS" },
            { type: "clearIsSpeaking" },
          ],
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
                { type: "traceInterruptionPending" },
                { type: "emitAITurnInterruptionPending" },
                { type: "emitAudioClear" },
                { type: "clearAudioStreamer" },
                { type: "clearTTSProvider" },
                { type: "cancelActiveTTSRequest" },
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
                { type: "traceAITurnInterrupted" },
                { type: "emitAITurnInterrupted" },
                { type: "emitAudioClear" },
                { type: "clearAudioStreamer" },
                { type: "clearTTSProvider" },
                { type: "markAITurnTerminalEmitted" },
                { type: "abortTurnController" },
                { type: "createNewTurnAbortController" },
                { type: "clearDynamicActorRefs" },
                { type: "clearIsSpeaking" },
                { type: "clearAITurnHadAudio" },
                { type: "clearAITurnResponseState" },
                { type: "clearPendingInterruptionStartedAt" },
                { type: "clearPendingInterruptionCutoffEmitted" },
                { type: "resetTurnMetrics" },
                { type: "recordHumanTurnStart" },
                { type: "setHumanTurnStarted" },
                { type: "traceHumanTurnStarted" },
                { type: "emitHumanTurnStarted" },
              ],
            },
            "_vad:speech-start": [
              {
                guard: "shouldStartPendingInterruptionImmediately",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "traceSpeechStarted" },
                  { type: "setPendingInterruptionStartedAt" },
                  { type: "traceInterruptionPending" },
                  { type: "emitAITurnInterruptionPending" },
                  { type: "emitAudioClear" },
                  { type: "clearAudioStreamer" },
                  { type: "clearTTSProvider" },
                  { type: "cancelActiveTTSRequest" },
                  { type: "setPendingInterruptionCutoffEmitted" },
                  { type: "scheduleInterruptionConfirmation" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: "shouldStartPendingInterruption",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "traceSpeechStarted" },
                  { type: "setPendingInterruptionStartedAt" },
                  { type: "scheduleInterruptionCutoff" },
                  { type: "scheduleInterruptionConfirmation" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: "hasVADAdapter",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "traceSpeechStarted" },
                  { type: "recordHumanTurnStart" },
                  { type: "setHumanTurnStarted" },
                  { type: "traceHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                  { type: "forwardToTurnDetector" },
                ],
              },
            ],
            "_stt:speech-start": [
              {
                guard: "shouldStartPendingSTTInterruptionImmediately",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "traceSpeechStarted" },
                  { type: "setSpeechStartedAt" },
                  { type: "setPendingInterruptionStartedAt" },
                  { type: "traceInterruptionPending" },
                  { type: "emitAITurnInterruptionPending" },
                  { type: "emitAudioClear" },
                  { type: "clearAudioStreamer" },
                  { type: "clearTTSProvider" },
                  { type: "cancelActiveTTSRequest" },
                  { type: "setPendingInterruptionCutoffEmitted" },
                  { type: "scheduleInterruptionConfirmation" },
                  { type: "recordHumanTurnStart" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: "shouldStartPendingSTTInterruption",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "traceSpeechStarted" },
                  { type: "setSpeechStartedAt" },
                  { type: "setPendingInterruptionStartedAt" },
                  { type: "scheduleInterruptionCutoff" },
                  { type: "scheduleInterruptionConfirmation" },
                  { type: "recordHumanTurnStart" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: "usesSTTForVAD",
                target: ".userSpeaking",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "traceSpeechStarted" },
                  { type: "setSpeechStartedAt" },
                  { type: "recordHumanTurnStart" },
                  { type: "forwardToTurnDetector" },
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
                      { type: "traceSpeechEnded" },
                      { type: "cancelInterruptionCutoff" },
                      { type: "cancelInterruptionConfirmation" },
                      { type: "recordAITurnInterrupted" },
                      { type: "traceAITurnInterrupted" },
                      { type: "emitAITurnInterrupted" },
                      { type: "emitAudioClear" },
                      { type: "clearAudioStreamer" },
                      { type: "clearTTSProvider" },
                      { type: "markAITurnTerminalEmitted" },
                      { type: "abortTurnController" },
                      { type: "createNewTurnAbortController" },
                      { type: "clearDynamicActorRefs" },
                      { type: "clearIsSpeaking" },
                      { type: "clearAITurnHadAudio" },
                      { type: "clearAITurnResponseState" },
                      { type: "clearPendingInterruptionStartedAt" },
                      { type: "clearPendingInterruptionCutoffEmitted" },
                      { type: "resetTurnMetrics" },
                      { type: "recordHumanTurnStart" },
                      { type: "setHumanTurnStarted" },
                      { type: "traceHumanTurnStarted" },
                      { type: "emitHumanTurnStarted" },
                      { type: "forwardToTurnDetector" },
                    ],
                  },
                  {
                    guard: "shouldCancelEmittedPendingInterruption",
                    target: "idle",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "traceSpeechEnded" },
                      { type: "cancelInterruptionCutoff" },
                      { type: "cancelInterruptionConfirmation" },
                      { type: "traceInterruptionCancelled" },
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
                      { type: "debugLogEvent" },
                      { type: "traceSpeechEnded" },
                      { type: "cancelInterruptionCutoff" },
                      { type: "cancelInterruptionConfirmation" },
                      { type: "clearPendingInterruptionStartedAt" },
                      { type: "clearPendingInterruptionCutoffEmitted" },
                      { type: "forwardToTurnDetector" },
                    ],
                  },
                  {
                    guard: "hasVADAdapter",
                    target: "idle",
                    actions: [{ type: "traceSpeechEnded" }, { type: "forwardToTurnDetector" }],
                  },
                ],
                "_stt:speech-end": [
                  {
                    guard: "shouldCancelEmittedPendingInterruption",
                    target: "idle",
                    actions: [
                      { type: "traceSpeechEnded" },
                      { type: "clearSpeechStartedAt" },
                      { type: "cancelInterruptionCutoff" },
                      { type: "cancelInterruptionConfirmation" },
                      { type: "traceInterruptionCancelled" },
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
                      { type: "traceSpeechEnded" },
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
                    actions: [
                      { type: "traceSpeechEnded" },
                      { type: "clearSpeechStartedAt" },
                      { type: "forwardToTurnDetector" },
                    ],
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
                guard: "shouldSpeculativelyCutFromSTTInterimBeforeHumanTurn",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "cancelInterruptionCutoff" },
                  { type: "cancelInterruptionConfirmation" },
                  { type: "setHumanTurnStarted" },
                  { type: "traceHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                  { type: "recordHumanTurnStart" },
                  { type: "setPendingInterruptionStartedAtIfUnset" },
                  { type: "traceInterimSpeechStarted" },
                  { type: "traceInterruptionPending" },
                  { type: "emitAITurnInterruptionPending" },
                  { type: "emitAudioClear" },
                  { type: "clearAudioStreamer" },
                  { type: "clearTTSProvider" },
                  { type: "cancelActiveTTSRequest" },
                  { type: "setPendingInterruptionCutoffEmitted" },
                  { type: "scheduleInterruptionConfirmation" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "updatePartialTranscriptFromEvent" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: "shouldSpeculativelyCutFromSTTInterim",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "cancelInterruptionCutoff" },
                  { type: "cancelInterruptionConfirmation" },
                  { type: "setPendingInterruptionStartedAtIfUnset" },
                  { type: "traceInterimSpeechStarted" },
                  { type: "traceInterruptionPending" },
                  { type: "emitAITurnInterruptionPending" },
                  { type: "emitAudioClear" },
                  { type: "clearAudioStreamer" },
                  { type: "clearTTSProvider" },
                  { type: "cancelActiveTTSRequest" },
                  { type: "setPendingInterruptionCutoffEmitted" },
                  { type: "scheduleInterruptionConfirmation" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "updatePartialTranscriptFromEvent" },
                  { type: "forwardToTurnDetector" },
                ],
              },
              {
                guard: "canInterruptFromSTT",
                actions: [
                  { type: "debugLogEvent" },
                  { type: "cancelInterruptionCutoff" },
                  { type: "cancelInterruptionConfirmation" },
                  { type: "recordAITurnInterrupted" },
                  { type: "traceAITurnInterrupted" },
                  { type: "emitAITurnInterrupted" },
                  { type: "emitAudioClear" },
                  { type: "clearAudioStreamer" },
                  { type: "clearTTSProvider" },
                  { type: "markAITurnTerminalEmitted" },
                  { type: "abortTurnController" },
                  { type: "createNewTurnAbortController" },
                  { type: "clearDynamicActorRefs" },
                  { type: "clearIsSpeaking" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearAITurnResponseState" },
                  { type: "clearSpeechStartedAt" },
                  { type: "clearPendingInterruptionStartedAt" },
                  { type: "clearPendingInterruptionCutoffEmitted" },
                  { type: "resetTurnMetrics" },
                  { type: "setHumanTurnStarted" },
                  { type: "traceHumanTurnStarted" },
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
                  { type: "traceHumanTurnStarted" },
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
                  { type: "traceHumanTurnStarted" },
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
                  { type: "traceHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                  { type: "recordHumanTurnStart" },
                  { type: "debugLogEvent" },
                  { type: "recordHumanTurnEnd" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "traceHumanTurnEnded" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromSTT" },
                  { type: "cancelInterruptionCutoff" },
                  { type: "cancelInterruptionConfirmation" },
                  { type: "recordAITurnInterrupted" },
                  { type: "traceAITurnInterrupted" },
                  { type: "emitAITurnInterrupted" },
                  { type: "emitAudioClear" },
                  { type: "clearAudioStreamer" },
                  { type: "clearTTSProvider" },
                  { type: "markAITurnTerminalEmitted" },
                  { type: "abortTurnController" },
                  { type: "createNewTurnAbortController" },
                  { type: "clearDynamicActorRefs" },
                  { type: "clearIsSpeaking" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearAITurnResponseState" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "clearPendingInterruptionStartedAt" },
                  { type: "clearPendingInterruptionCutoffEmitted" },
                  { type: "resetTurnMetrics" },
                  { type: "recordAITurnStart" },
                  { type: "traceAITurnStarted" },
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
                  { type: "traceHumanTurnEnded" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromSTT" },
                  { type: "cancelInterruptionCutoff" },
                  { type: "cancelInterruptionConfirmation" },
                  { type: "recordAITurnInterrupted" },
                  { type: "traceAITurnInterrupted" },
                  { type: "emitAITurnInterrupted" },
                  { type: "emitAudioClear" },
                  { type: "clearAudioStreamer" },
                  { type: "clearTTSProvider" },
                  { type: "markAITurnTerminalEmitted" },
                  { type: "abortTurnController" },
                  { type: "createNewTurnAbortController" },
                  { type: "clearDynamicActorRefs" },
                  { type: "clearIsSpeaking" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearAITurnResponseState" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "clearPendingInterruptionStartedAt" },
                  { type: "clearPendingInterruptionCutoffEmitted" },
                  { type: "resetTurnMetrics" },
                  { type: "recordAITurnStart" },
                  { type: "traceAITurnStarted" },
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
                  { type: "traceHumanTurnStarted" },
                  { type: "emitHumanTurnStarted" },
                  { type: "recordHumanTurnStart" },
                  { type: "debugLogEvent" },
                  { type: "recordHumanTurnEnd" },
                  { type: "emitHumanTurnTranscript" },
                  { type: "traceHumanTurnEnded" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromSTT" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "recordAITurnStart" },
                  { type: "traceAITurnStarted" },
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
                  { type: "traceHumanTurnEnded" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromSTT" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "recordAITurnStart" },
                  { type: "traceAITurnStarted" },
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
                  { type: "traceHumanTurnEnded" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromTurnEnd" },
                  { type: "recordAITurnInterrupted" },
                  { type: "traceAITurnInterrupted" },
                  { type: "emitAITurnInterrupted" },
                  { type: "emitAudioClear" },
                  { type: "clearAudioStreamer" },
                  { type: "clearTTSProvider" },
                  { type: "markAITurnTerminalEmitted" },
                  { type: "abortTurnController" },
                  { type: "createNewTurnAbortController" },
                  { type: "clearDynamicActorRefs" },
                  { type: "clearIsSpeaking" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearAITurnResponseState" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "resetTurnMetrics" },
                  { type: "recordAITurnStart" },
                  { type: "traceAITurnStarted" },
                  { type: "emitAITurnStarted" },
                  { type: "spawnLLM" },
                ],
              },
              {
                actions: [
                  { type: "recordHumanTurnEnd" },
                  { type: "traceHumanTurnEnded" },
                  { type: "emitHumanTurnEnded" },
                  { type: "addUserMessageFromTurnEnd" },
                  { type: "clearAITurnHadAudio" },
                  { type: "clearHumanTurnStarted" },
                  { type: "clearSpeechStartedAt" },
                  { type: "recordAITurnStart" },
                  { type: "traceAITurnStarted" },
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
                guard: ({ context }) => context.pendingInterruptionCutoffEmitted,
                actions: [
                  { type: "recordFirstSentence" },
                  { type: "recordSentence" },
                  { type: "emitAITurnSentence" },
                  { type: "traceAITurnSentence" },
                ],
              },
              {
                guard: ({ context }) => context.activeTTSRequestId === null,
                actions: [
                  { type: "recordFirstSentence" },
                  { type: "recordSentence" },
                  { type: "emitAITurnSentence" },
                  { type: "traceAITurnSentence" },
                  { type: "setIsSpeaking" },
                  { type: "queueSentence" },
                  { type: "spawnTTSFromQueue" },
                  { type: "sendActiveTTSRequest" },
                  { type: "traceTTSQueueState" },
                ],
              },
              {
                actions: [
                  { type: "recordFirstSentence" },
                  { type: "recordSentence" },
                  { type: "emitAITurnSentence" },
                  { type: "traceAITurnSentence" },
                  { type: "queueSentence" },
                  { type: "traceTTSQueueState" },
                ],
              },
            ],
            "_llm:complete": [
              {
                guard: "canCompleteAITurnAfterLLMComplete",
                actions: [
                  { type: "clearLLMRef" },
                  { type: "storeLLMCompleteFromEvent" },
                  { type: "recordResponseLengthFromComplete" },
                  { type: "recordAITurnComplete" },
                  { type: "clearIsSpeaking" },
                  { type: "traceAITurnEnded" },
                  { type: "emitAITurnEnded" },
                  { type: "addAssistantMessageFromStoredResponse" },
                  { type: "markAITurnTerminalEmitted" },
                  { type: "clearAITurnResponseState" },
                  { type: "resetTurnMetrics" },
                ],
              },
              {
                actions: [
                  { type: "clearLLMRef" },
                  { type: "storeLLMCompleteFromEvent" },
                  { type: "recordResponseLengthFromComplete" },
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
                    { type: "recordAudioStartedTextFromCurrentTTS" },
                    { type: "recordFirstAudio" },
                    { type: "recordAudioChunk" },
                    { type: "traceAITurnAudio" },
                    { type: "emitAITurnAudio" },
                    { type: "forwardAudioToStreamer" },
                  ],
                },
                "_tts:complete": [
                  {
                    guard: "hasPendingSentencesForCurrentTTS",
                    actions: [
                      { type: "recordAudioCompletedTextFromCurrentTTS" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "spawnTTSFromQueue" },
                      { type: "sendActiveTTSRequest" },
                      { type: "traceTTSQueueState" },
                    ],
                  },
                  {
                    guard: "canCompleteAITurnAfterCurrentTTS",
                    actions: [
                      { type: "recordAudioCompletedTextFromCurrentTTS" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "recordAITurnComplete" },
                      { type: "clearIsSpeaking" },
                      { type: "traceAITurnEnded" },
                      { type: "emitAITurnEnded" },
                      { type: "addAssistantMessageFromStoredResponse" },
                      { type: "markAITurnTerminalEmitted" },
                      { type: "clearAITurnResponseState" },
                      { type: "resetTurnMetrics" },
                    ],
                  },
                  {
                    guard: "matchesActiveTTSRequest",
                    actions: [
                      { type: "recordAudioCompletedTextFromCurrentTTS" },
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
                      { type: "sendActiveTTSRequest" },
                      { type: "traceTTSQueueState" },
                    ],
                  },
                  {
                    guard: "canCompleteAITurnAfterCurrentTTS",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "recordError" },
                      { type: "emitAgentError" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "recordAITurnComplete" },
                      { type: "clearIsSpeaking" },
                      { type: "traceAITurnEnded" },
                      { type: "emitAITurnEnded" },
                      { type: "addAssistantMessageFromStoredResponse" },
                      { type: "markAITurnTerminalEmitted" },
                      { type: "clearAITurnResponseState" },
                      { type: "resetTurnMetrics" },
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
                    { type: "setAITurnHadAudio" },
                    { type: "recordAudioStartedTextFromCurrentTTS" },
                    { type: "recordAudioChunk" },
                    { type: "traceAITurnAudio" },
                    { type: "emitAITurnAudio" },
                    { type: "forwardAudioToStreamer" },
                  ],
                },
                "_tts:complete": [
                  {
                    guard: "hasPendingSentencesForCurrentTTS",
                    actions: [
                      { type: "recordAudioCompletedTextFromCurrentTTS" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "spawnTTSFromQueue" },
                      { type: "sendActiveTTSRequest" },
                      { type: "traceTTSQueueState" },
                    ],
                  },
                  {
                    guard: "canCompleteAITurnAfterCurrentTTS",
                    target: "silent",
                    actions: [
                      { type: "recordAudioCompletedTextFromCurrentTTS" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "recordAITurnComplete" },
                      { type: "clearIsSpeaking" },
                      { type: "traceAITurnEnded" },
                      { type: "emitAITurnEnded" },
                      { type: "addAssistantMessageFromStoredResponse" },
                      { type: "markAITurnTerminalEmitted" },
                      { type: "clearAITurnResponseState" },
                      { type: "resetTurnMetrics" },
                    ],
                  },
                  {
                    guard: "matchesActiveTTSRequest",
                    target: "silent",
                    actions: [
                      { type: "recordAudioCompletedTextFromCurrentTTS" },
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
                      { type: "sendActiveTTSRequest" },
                      { type: "traceTTSQueueState" },
                    ],
                  },
                  {
                    guard: "canCompleteAITurnAfterCurrentTTS",
                    target: "silent",
                    actions: [
                      { type: "debugLogEvent" },
                      { type: "recordError" },
                      { type: "emitAgentError" },
                      { type: "clearTTSRef" },
                      { type: "decrementPendingTTS" },
                      { type: "recordAITurnComplete" },
                      { type: "clearIsSpeaking" },
                      { type: "traceAITurnEnded" },
                      { type: "emitAITurnEnded" },
                      { type: "addAssistantMessageFromStoredResponse" },
                      { type: "markAITurnTerminalEmitted" },
                      { type: "clearAITurnResponseState" },
                      { type: "resetTurnMetrics" },
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
                      { type: "clearIsSpeaking" },
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
        { type: "traceAgentStopped" },
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
