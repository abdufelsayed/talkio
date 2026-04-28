# talkio

Orchestration library for building realtime voice AI agents. Coordinates STT, LLM, and TTS with automatic turn management and interruption detection.

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
      case "human-turn:ended":
        console.log("User:", event.transcript);
        break;
      case "ai-turn:sentence":
        console.log("Agent:", event.sentence);
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

| Option         | Required | Description                                                           |
| -------------- | -------- | --------------------------------------------------------------------- |
| `stt`          | Yes      | Speech-to-text provider                                               |
| `llm`          | Yes      | Language model provider                                               |
| `tts`          | Yes      | Text-to-speech provider                                               |
| `audio`        | No       | `{ input, output }` - see [Audio Configuration](#audio-configuration) |
| `vad`          | No       | Voice activity detection (falls back to STT)                          |
| `turnDetector` | No       | Custom turn detection (falls back to STT final transcript)            |
| `interruption` | No       | `{ enabled: true, minDurationMs: 200 }`                               |
| `onEvent`      | No       | Event callback                                                        |

### Agent

```typescript
interface Agent {
  start(): void;
  sendAudio(audio: Float32Array): void;
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

## Events

```typescript
// Lifecycle
"agent:started";
"agent:stopped";
"agent:error"; // { error, source: "stt" | "llm" | "tts" }

// Human turn
"human-turn:started";
"human-turn:transcript"; // { text, isFinal }
"human-turn:ended"; // { transcript }

// AI turn
"ai-turn:started";
"ai-turn:token"; // { token }
"ai-turn:sentence"; // { sentence, index }
"ai-turn:audio"; // { audio: ArrayBuffer }
"ai-turn:ended"; // { text, wasSpoken }
"ai-turn:interrupted"; // { partialText }
"audio:clear"; // stop playback and drop queued audio immediately
```

## Creating Providers

Use factory functions to create providers. STT/TTS providers must declare their supported audio formats:

```typescript
import { createCustomSTTProvider, createCustomLLMProvider, createCustomTTSProvider } from "talkio";

// Define supported formats for STT
const sttFormats = [
  { encoding: "linear16", sampleRate: 16000, channels: 1 },
  { encoding: "linear16", sampleRate: 24000, channels: 1 },
] as const;

const stt = createCustomSTTProvider({
  name: "MySTT",
  supportedInputFormats: sttFormats,
  defaultInputFormat: sttFormats[0],
  start: (ctx) => {
    // ctx.audioFormat - the selected input format
    // ctx.transcript(text, isFinal), ctx.speechStart(), ctx.speechEnd()
  },
  stop: () => {},
  sendAudio: (audio) => {},
});

const llm = createCustomLLMProvider({
  name: "MyLLM",
  generate: async (messages, ctx) => {
    // ctx.token(), ctx.sentence(), ctx.complete()
  },
});

// Define supported formats for TTS
const ttsFormats = [{ encoding: "linear16", sampleRate: 24000, channels: 1 }] as const;

const tts = createCustomTTSProvider({
  name: "MyTTS",
  supportedOutputFormats: ttsFormats,
  defaultOutputFormat: ttsFormats[0],
  start: async (ctx) => {
    // ctx.audioFormat - the selected output format
    // ctx.audioChunk(), ctx.complete()
  },
  speak: async (text) => {},
  flush: async () => {},
  clear: async () => {},
  stop: async () => {},
});
```

Provider session contexts receive `ctx.signal` (AbortSignal) for cancellation.

## License

Apache-2.0
