# talkio

Orchestration library for building realtime voice AI agents. A fast **talker** model speaks with the user while a **thinker** model works in the background with your tools, so the agent answers right away and stays smart. Around them, human-like turn-taking: semantic end-of-turn detection, replies prepared before the user finishes, interruptions confirmed by words, and backchannels.

See the [repository README](../../README.md) for a guided tour of each feature.

## Installation

```bash
npm install talkio
```

## Quick Start

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { aiSdk } from "@talkio/ai-sdk";
import { createDeepgram } from "@talkio/deepgram";
import { tool } from "ai";
import { createAgent } from "talkio";
import { z } from "zod";

const deepgram = createDeepgram({ apiKey: process.env.DEEPGRAM_API_KEY });

const agent = createAgent({
  stt: deepgram.stt({ model: "nova-3" }),
  tts: deepgram.tts({ model: "aura-2-thalia-en" }),
  talker: aiSdk(anthropic("claude-haiku-5-5")),
  thinker: aiSdk(anthropic("claude-opus-5-5")),
  instructions: "You are Ava, the receptionist at Acme Dental.",
  tools: {
    findAppointment: tool({
      description: "Find the caller's next appointment",
      inputSchema: z.object({ phone: z.string() }),
      execute: ({ phone }) => appointments.next(phone),
    }),
  },
  onEvent: (event) => {
    switch (event.type) {
      case "user-turn:ended":
        console.log("User:", event.text);
        break;
      case "agent-turn:audio":
        playAudio(event.audio);
        break;
      case "audio:pause": // the user started talking over the agent
        pausePlayback();
        break;
      case "audio:resume": // it was not an interruption
        resumePlayback();
        break;
      case "audio:clear": // it was: drop audio that has not played
        clearPlayback();
        break;
    }
  },
});

agent.start();
agent.sendAudio(audioChunk); // Float32Array from microphone
agent.stop();
```

## Talker and thinker

The talker answers every turn. Anything that needs a tool, a lookup, or careful reasoning it hands to the thinker with its one tool, `think`, and tells the user it is on it. The thinker works in the background, one step at a time, while the conversation goes on: the user can keep talking, change the request, or ask about something else. When the thinker writes what it found, the talker tells the user at the next moment nobody is speaking.

Both read one append-only **timeline** of the conversation: what the user said, what they heard the agent say (and where they cut it off), the talker's requests, and the thinker's tool calls, results, and findings. The talker sees the thinker's tool results, so it answers follow-up questions from them without another round trip. A request the user changes or cancels reaches the thinker through the timeline at its next step.

Without `thinker` and `tools`, the talker answers everything itself.

## API

### `createAgent(config)`

| Option         | Required | Description                                                                                                                             |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `stt`          | Yes      | Speech-to-text provider                                                                                                                 |
| `talker`       | Yes      | The model that talks with the user: an `LLMProvider` or `LLMFunction`, such as `aiSdk(model)`                                           |
| `tts`          | Yes      | Text-to-speech provider                                                                                                                 |
| `thinker`      | No       | The model that works in the background with `tools`; defaults to the talker's model when `tools` are given                              |
| `instructions` | No       | Persona, procedures, and guardrails, followed by both models                                                                            |
| `tools`        | No       | Tools the thinker can call; AI SDK `tool()` definitions work as they are                                                                |
| `vad`          | No       | Voice activity detection (falls back to the STT's speech events)                                                                        |
| `turnDetector` | No       | A function scoring pauses, a `TurnDetector`, or several (falls back to the STT's turn signals, then its final transcripts)              |
| `turnTaking`   | No       | `{ eagerness, minDelayMs, maxDelayMs, threshold, preemptiveGeneration, eagerThreshold }`                                                |
| `interruption` | No       | On by default; `false`, or `{ minDurationMs, pauseAfterMs, minWords, minChars, resumeAfterMs, maxPendingMs, classifier, pendingAudio }` |
| `playback`     | No       | `{ outputLatencyMs }`, for estimating what the listener heard                                                                           |
| `backchannels` | No       | `true` or `{ phrases, minSpeechMs, pauseMs, maxEndOfTurnProbability }`, said while the user talks                                       |
| `silence`      | No       | `true` or `{ afterMs, startMode, maxPrompts }`, wakes the talker when both sides go quiet                                               |
| `timeout`      | No       | `{ talkerMs, ttsMs }`; off by default                                                                                                   |
| `audio`        | No       | `{ input, output }` - see [Audio Configuration](#audio-configuration)                                                                   |
| `onTrace`      | No       | Receives timestamped trace events                                                                                                       |
| `onEvent`      | No       | Event callback                                                                                                                          |

### Agent

```typescript
interface Agent {
  readonly id: string;
  readonly audioStream: ReadableStream<ArrayBuffer>; // same chunks as agent-turn:audio
  start(): void;
  sendAudio(audio: AudioInput): void; // ArrayBuffer, Blob, typed arrays, or Buffer
  say(text: string): void; // speak fixed text without the talker
  reportPlayback(report: { turnId: string; playedMs: number }): void; // optional client progress
  stop(): void;
  subscribe(callback: (state: AgentState) => void): () => void;
  getSnapshot(): AgentState;
}
```

## Audio Configuration

Audio formats only require `encoding`. Sample rate and channels have sensible defaults.

```typescript
// Minimal - just specify encoding
createAgent({
  stt,
  talker,
  tts,
  audio: {
    input: { encoding: "linear16" }, // defaults to 16000 Hz, mono
    output: { encoding: "linear16" }, // defaults to 24000 Hz, mono
  },
});

// Explicit - override defaults
createAgent({
  stt,
  talker,
  tts,
  audio: {
    input: { encoding: "linear16", sampleRate: 24000, channels: 1 },
    output: { encoding: "linear16", sampleRate: 48000, channels: 1 },
  },
});

// Omit audio - uses provider default formats
createAgent({ stt, talker, tts });
```

### Supported Encodings

| Category   | Encodings                                |
| ---------- | ---------------------------------------- |
| PCM        | `linear16`, `linear32`, `float32`        |
| Telephony  | `mulaw`, `alaw`                          |
| Compressed | `opus`, `ogg-opus`, `flac`, `mp3`, `aac` |
| Container  | `wav`, `webm`, `ogg`, `mp4`              |

With PCM and telephony output the agent tracks playback, so `heardText` and the end of each agent turn follow the audio the listener actually played.

## Events

```typescript
// Lifecycle
"agent:started";
"agent:stopped";
"agent:error"; // { error, source: "stt" | "talker" | "thinker" | "tts" | "vad" | "turnDetector" }

// User turn
"user-turn:started";
"user-turn:transcript"; // { text, isFinal }
"user-turn:ended"; // { text, metrics }
"user-turn:abandoned"; // { reason }: speech that was not a turn, such as noise

// Agent turn
"agent-turn:started";
"agent-turn:token"; // { token }
"agent-turn:sentence"; // { sentence, index }
"agent-turn:audio"; // { audio: ArrayBuffer }
"agent-turn:ended"; // { text, wasSpoken, metrics }, once the audio has played
"agent-turn:interruption-pending"; // the user started talking over the agent
"agent-turn:interruption-cancelled"; // { reason: "false-start" | "backchannel" | "echo" | "no-transcript" }
"agent-turn:interrupted"; // { heardText, generatedText, metrics }

// Playback control
"audio:pause"; // pause playback while an interruption is pending
"audio:resume"; // continue where playback paused
"audio:clear"; // drop audio that has not played

// Conversation
"timeline:entry"; // { entry }: speech, think requests, and the thinker's tool calls, results, and findings
"agent:backchannel"; // { text }; its audio follows as agent-turn:audio
"silence:detected"; // { promptCount, maxPrompts }

// Debug
"vad:probability"; // { value }
```

## Creating Providers

Use factory functions to create providers. STT/TTS providers must declare their supported audio formats:

```typescript
import { createLLM, createSTT, createTTS, type TurnDetector } from "talkio";

// Define supported formats for STT
const sttFormats = [
  { encoding: "linear16", sampleRate: 16000, channels: 1 },
  { encoding: "linear16", sampleRate: 24000, channels: 1 },
] as const;

const stt = createSTT({
  name: "MySTT",
  supportedInputFormats: sttFormats,
  defaultInputFormat: sttFormats[0],
  turnDetection: false, // true if the service reports turns itself
  start: (ctx) => {
    // ctx.audioFormat - the selected input format
    // ctx.transcript(text, isFinal), ctx.speechStart(), ctx.speechEnd()
    // ctx.turn.end(), eagerEnd(), resumed(), probability()
  },
  stop: () => {},
  sendAudio: (audio) => {},
});

// A model for the talker or the thinker (@talkio/ai-sdk wraps any AI SDK model)
const model = createLLM({
  name: "MyModel",
  generate: async (ctx) => {
    // ctx.messages starts with the system message; ctx.tools lists the tools it may call
    // return a stream of text, or report through ctx:
    // ctx.token() - the agent splits tokens into sentences; ctx.sentence() is optional
    // ctx.toolCall() - talkio runs the tool and calls the model again with the result
    // ctx.complete(), ctx.error()
  },
});

// Define supported formats for TTS
const ttsFormats = [{ encoding: "linear16", sampleRate: 24000, channels: 1 }] as const;

const tts = createTTS({
  name: "MyTTS",
  supportedOutputFormats: ttsFormats,
  defaultOutputFormat: ttsFormats[0],
  start: async (ctx) => {
    // ctx.audioFormat - the selected output format
    // ctx.audio(), ctx.complete()
    // ctx.wordTimings() - optional, makes heardText word-accurate
  },
  speak: async (text) => {},
  flush: async () => {},
  clear: async () => {},
  stop: async () => {},
});

// A turn detector can be a function: return how likely the user is done
const scorePause = ({ transcript, timeline, signal }) =>
  model.score(transcript, timeline, { signal });

// Or an object implementing only what it needs
const turnDetector: TurnDetector = {
  name: "MyTurnDetector",
  output: "probability", // "decision": end turns with ctx.turn.end()
  start: async (ctx) => {}, // ctx.audioFormat, ctx.turn, ctx.error()
  onPause: ({ transcript, timeline, signal }) => 0.8,
  // stop, sendAudio, onTranscript, and onSpeechStart are optional
};
```

Provider session contexts receive `ctx.signal` (AbortSignal) for cancellation. `@talkio/testkit` checks providers against these contracts.

## License

Apache-2.0
