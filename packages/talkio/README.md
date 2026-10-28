# talkio

Orchestration library for building realtime voice AI agents. Coordinates STT, LLM, and TTS with human-like turn-taking: semantic end-of-turn detection, replies prepared before the user finishes, interruptions confirmed by words, fillers, and backchannels.

See the [repository README](../../README.md) for a guided tour of each feature.

## Installation

```bash
npm install talkio
```

## Quick Start

```typescript
import { createAgent } from "talkio";
import { createDeepgram } from "@talkio/deepgram";

const deepgram = createDeepgram({ apiKey: process.env.DEEPGRAM_API_KEY });

const agent = createAgent({
  stt: deepgram.stt({ model: "nova-3" }),
  llm: myLLMProvider,
  tts: deepgram.tts({ model: "aura-2-thalia-en" }),
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

## API

### `createAgent(config)`

| Option         | Required | Description                                                                                                                             |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `stt`          | Yes      | Speech-to-text provider                                                                                                                 |
| `llm`          | Yes      | Language model provider or `LLMFunction`; either may return a stream of text                                                            |
| `tts`          | Yes      | Text-to-speech provider                                                                                                                 |
| `vad`          | No       | Voice activity detection (falls back to the STT's speech events)                                                                        |
| `turnDetector` | No       | A function scoring pauses, a `TurnDetector`, or several (falls back to the STT's turn signals, then its final transcripts)              |
| `turnTaking`   | No       | `{ eagerness, minDelayMs, maxDelayMs, threshold, preemptiveGeneration, eagerThreshold }`                                                |
| `interruption` | No       | On by default; `false`, or `{ minDurationMs, pauseAfterMs, minWords, minChars, resumeAfterMs, maxPendingMs, classifier, pendingAudio }` |
| `playback`     | No       | `{ outputLatencyMs }`, for estimating what the listener heard                                                                           |
| `fillers`      | No       | `true` or `{ afterMs, phrases }`, said when a reply is slow to start                                                                    |
| `backchannels` | No       | `true` or `{ phrases, minSpeechMs, pauseMs, maxEndOfTurnProbability }`, said while the user talks                                       |
| `silence`      | No       | `true` or `{ afterMs, startMode, prompt, maxPrompts }`, prompts a quiet user                                                            |
| `timeout`      | No       | `{ llmMs, ttsMs }`; off by default                                                                                                      |
| `audio`        | No       | `{ input, output }` - see [Audio Configuration](#audio-configuration)                                                                   |
| `maxMessages`  | No       | History length kept for the LLM (system messages are always kept)                                                                       |
| `onTrace`      | No       | Receives timestamped trace events                                                                                                       |
| `onEvent`      | No       | Event callback                                                                                                                          |

### Agent

```typescript
interface Agent {
  readonly id: string;
  readonly audioStream: ReadableStream<ArrayBuffer>; // same chunks as agent-turn:audio
  start(): void;
  sendAudio(audio: AudioInput): void; // ArrayBuffer, Blob, typed arrays, or Buffer
  say(text: string): void; // speak fixed text without the LLM
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
  llm,
  tts,
  audio: {
    input: { encoding: "linear16" }, // defaults to 16000 Hz, mono
    output: { encoding: "linear16" }, // defaults to 24000 Hz, mono
  },
});

// Explicit - override defaults
createAgent({
  stt,
  llm,
  tts,
  audio: {
    input: { encoding: "linear16", sampleRate: 24000, channels: 1 },
    output: { encoding: "linear16", sampleRate: 48000, channels: 1 },
  },
});

// Omit audio - uses provider default formats
createAgent({ stt, llm, tts });
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
"agent:error"; // { error, source: "stt" | "llm" | "tts" | "vad" | "turnDetector" }

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

const llm = createLLM({
  name: "MyLLM",
  generate: async (ctx) => {
    // return a stream of text (e.g. AI SDK's textStream), or report through ctx:
    // ctx.token() - the agent splits tokens into sentences; ctx.sentence() is optional
    // ctx.complete(), ctx.say(), ctx.interrupt()
    // await ctx.turnConfirmed() before side effects in a preemptive generation
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
const scorePause = ({ transcript, messages, signal }) =>
  model.score(transcript, messages, { signal });

// Or an object implementing only what it needs
const turnDetector: TurnDetector = {
  name: "MyTurnDetector",
  output: "probability", // "decision": end turns with ctx.turn.end()
  start: async (ctx) => {}, // ctx.audioFormat, ctx.turn, ctx.error()
  onPause: ({ transcript, messages, signal }) => 0.8,
  // stop, sendAudio, onTranscript, and onSpeechStart are optional
};
```

Provider session contexts receive `ctx.signal` (AbortSignal) for cancellation. `@talkio/testkit` checks providers against these contracts.

## License

Apache-2.0
