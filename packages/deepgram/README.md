# @talkio/deepgram

Deepgram STT and TTS providers for [talkio](https://github.com/abdufelsayed/voice-ai). Uses Deepgram's WebSocket APIs for streaming.

## Installation

```bash
bun add @talkio/deepgram
# or
npm install @talkio/deepgram
# or
pnpm add @talkio/deepgram
```

**Peer Dependencies**: This package requires `talkio` to be installed.

## Quick Start

```typescript
import { createAgent } from "talkio";
import { createDeepgram } from "@talkio/deepgram";

const deepgram = createDeepgram({
  apiKey: process.env.DEEPGRAM_API_KEY,
});

const agent = createAgent({
  stt: deepgram.stt({ model: "nova-3" }),
  tts: deepgram.tts({ model: "aura-2-thalia-en" }),
  llm: myLLMProvider,
});

agent.start();
```

## Usage

### Provider Instance (Recommended)

Create a shared Deepgram instance to reuse configuration across STT and TTS:

```typescript
import { createDeepgram } from "@talkio/deepgram";

const deepgram = createDeepgram({
  apiKey: process.env.DEEPGRAM_API_KEY,
  baseUrl: "api.deepgram.com", // optional, for enterprise/proxy
});

// Create providers with shared config
const stt = deepgram.stt({ model: "nova-3" });
const tts = deepgram.tts({ model: "aura-2-thalia-en" });
```

### Direct Imports

For more control, import the factory functions directly:

```typescript
import { createDeepgramSTT, createDeepgramTTS } from "@talkio/deepgram";

const stt = createDeepgramSTT({
  apiKey: process.env.DEEPGRAM_API_KEY,
  model: "nova-3",
  language: "en",
  interimResults: true,
  punctuate: true,
  smartFormat: true,
});

const tts = createDeepgramTTS({
  apiKey: process.env.DEEPGRAM_API_KEY,
  model: "aura-2-thalia-en",
});
```

## API Reference

### `createDeepgram(settings?)`

Creates a Deepgram provider instance with shared configuration.

```typescript
interface DeepgramProviderSettings {
  apiKey?: string; // Falls back to DEEPGRAM_API_KEY env var
  baseUrl?: string; // Default: "api.deepgram.com"
}
```

Returns an object with `stt()` and `tts()` factory methods.

### `createDeepgramSTT(options)`

Creates a Speech-to-Text provider.

```typescript
interface DeepgramSTTOptions {
  // Required
  model: string; // e.g., "nova-3", "nova-2"

  // Optional
  apiKey?: string; // Falls back to provider settings or env var
  baseUrl?: string; // Falls back to provider settings
  language?: string; // Default: "en"
  interimResults?: boolean; // Default: true
  punctuate?: boolean; // Default: true
  smartFormat?: boolean; // Default: true
  endpointing?: number | false; // Default: 300 (ms)
  utteranceEndMs?: number; // Default: 1000 (ms)
  keywords?: string[]; // Terms to boost on Nova-2 and older ("term:intensifier")
  keyterms?: string[]; // Terms to boost on Nova-3 (up to 100)
  vad?: boolean; // Default: true
}
```

**Utterances:** Deepgram finalizes speech in segments (`is_final`), which can split a sentence mid-thought. The provider joins them and reports one final transcript per utterance, when Deepgram signals a pause: `speech_final` after `endpointing` ms of silence, or `UtteranceEnd` after `utteranceEndMs` without new words (this one needs `interimResults`). Interim transcripts include the segments finalized so far. For semantic turn detection instead of silence thresholds, use [`flux()`](#createdeepgramfluxoptions).

**Supported Models:**

- `nova-3` - Latest and most accurate
- `nova-2` - Fast and accurate
- `nova` - Original Nova model
- See [Deepgram Models](https://developers.deepgram.com/docs/models) for full list

**Supported Input Formats:**

| Encoding   | Sample Rates                 | Channels | Default  |
| ---------- | ---------------------------- | -------- | -------- |
| `linear16` | 8000, 16000, 24000, 48000 Hz | 1, 2     | 16000 Hz |
| `linear32` | 16000, 24000, 48000 Hz       | 1, 2     | -        |
| `flac`     | 16000, 24000, 48000 Hz       | 1, 2     | -        |
| `opus`     | 8000, 16000, 24000, 48000 Hz | 1, 2     | -        |
| `ogg-opus` | 8000, 16000, 24000, 48000 Hz | 1, 2     | -        |
| `speex`    | 8000, 16000, 32000 Hz        | 1        | -        |
| `mulaw`    | 8000 Hz                      | 1        | -        |
| `alaw`     | 8000 Hz                      | 1        | -        |
| `amr-nb`   | 8000 Hz                      | 1        | -        |
| `amr-wb`   | 16000 Hz                     | 1        | -        |
| `g729`     | 8000 Hz                      | 1        | -        |

The provider automatically uses its default format (`linear16` at 16000 Hz, mono) unless you specify `audio.input` in `createAgent()`.

### `createDeepgramTTS(options)`

Creates a Text-to-Speech provider.

```typescript
interface DeepgramTTSOptions {
  // Required
  model: string; // e.g., "aura-2-thalia-en"

  // Optional
  apiKey?: string; // Falls back to provider settings or env var
  baseUrl?: string; // Falls back to provider settings
  encoding?: "linear16" | "mulaw" | "alaw"; // Default: "linear16"
  sampleRate?: 8000 | 16000 | 24000 | 32000 | 48000; // Default: 24000 for linear16, 8000 for mulaw/alaw
}
```

**Voice Format:**

- Aura 2 voices: `aura-2-{voice}-{language}` (e.g., `aura-2-thalia-en`)
- See [Deepgram TTS Models](https://developers.deepgram.com/docs/tts-models) for available voices

**Supported Output Formats:**

| Encoding   | Sample Rates                        | Channels | Default  |
| ---------- | ----------------------------------- | -------- | -------- |
| `linear16` | 8000, 16000, 24000, 32000, 48000 Hz | 1        | 24000 Hz |
| `mulaw`    | 8000, 16000 Hz                      | 1        | 8000 Hz  |
| `alaw`     | 8000, 16000 Hz                      | 1        | 8000 Hz  |

The provider automatically uses its default format (`linear16` at 24000 Hz, mono) unless you specify `audio.output` in `createAgent()`.

### `createDeepgramFlux(options?)`

Creates a [Flux](https://developers.deepgram.com/docs/flux/quickstart) conversational STT provider. Flux decides when the user's turn ends, so you don't need a separate turn detector; the agent uses Flux's turn events instead of final transcripts.

```typescript
interface DeepgramFluxOptions {
  apiKey?: string; // Falls back to provider settings or env var
  baseUrl?: string; // Falls back to provider settings
  model?: "flux-general-en" | "flux-general-multi"; // Default: "flux-general-en"
  eotThreshold?: number; // 0.5–1.0, confidence needed to end the turn. Default: 0.7
  eagerEotThreshold?: number; // 0.3–0.9, at most eotThreshold. Enables eager end of turn
  eotTimeoutMs?: number; // 500–60000, silence that always ends the turn. Default: 5000
  keyterms?: string[]; // Terms to boost
  languageHints?: string[]; // flux-general-multi only
}
```

How Flux events map to the agent:

| Flux event       | Agent behavior                                                       |
| ---------------- | -------------------------------------------------------------------- |
| `StartOfTurn`    | Speech started: the agent yields if it is speaking (barge-in)        |
| `Update`         | Interim transcript and end-of-turn confidence                        |
| `EagerEndOfTurn` | The agent prepares its reply silently (preemptive generation)        |
| `TurnResumed`    | The prepared reply is discarded                                      |
| `EndOfTurn`      | Final transcript; the turn ends and the prepared reply plays at once |

Set `eagerEotThreshold` to cut response latency: the reply is already generated and synthesized when `EndOfTurn` arrives. It costs extra LLM and TTS calls whenever the user keeps talking after an eager end of turn.

```typescript
const agent = createAgent({
  stt: deepgram.flux({ eagerEotThreshold: 0.5 }),
  llm,
  tts: deepgram.tts({ model: "aura-2-thalia-en" }),
});
```

**Supported Input Formats:** `linear16` and `linear32` (8000, 16000, 24000, 44100, 48000 Hz), `opus` and `ogg-opus` (8000, 16000, 24000, 48000 Hz), `mulaw` and `alaw` (8000 Hz), all mono. Default: `linear16` at 16000 Hz.

## Connection Handling

Both STT providers stream over a WebSocket:

- Audio sent while connecting is buffered and sent once the socket opens.
- A connection that drops after opening is reopened with backoff (up to 5 attempts over about 15 seconds). Audio sent meanwhile, up to about 30 seconds of it, is delivered once it reconnects, and the error is only reported if it gives up. A connection that never opens, usually a bad key or parameter, is reported right away. With `flux()`, a turn the dropped stream was in ends with what was heard.
- `stt()` sends Deepgram's KeepAlive message when no audio has gone out for 4 seconds, so a client that pauses audio (push-to-talk, muting) keeps its stream; Deepgram closes idle streams after 10 seconds.

## Configuration

### API Key

The API key can be provided in three ways (in order of precedence):

1. Directly in options: `createDeepgramSTT({ apiKey: "..." })`
2. Via provider settings: `createDeepgram({ apiKey: "..." })`
3. Environment variable: `DEEPGRAM_API_KEY`

### Custom Base URL

For enterprise deployments or proxies:

```typescript
const deepgram = createDeepgram({
  apiKey: process.env.DEEPGRAM_API_KEY,
  baseUrl: "your-proxy.example.com",
});
```

## Examples

### Full Agent Setup

```typescript
import { createAgent } from "talkio";
import { createDeepgram } from "@talkio/deepgram";

const deepgram = createDeepgram();

const agent = createAgent({
  stt: deepgram.stt({
    model: "nova-3",
    language: "en",
    keyterms: ["Talkio", "Deepgram"], // Boost recognition
  }),
  tts: deepgram.tts({
    model: "aura-2-thalia-en",
  }),
  llm: myLLMProvider,
  onEvent: (event) => {
    if (event.type === "user-turn:transcript") {
      console.log("Transcript:", event.text);
    }
  },
});

agent.start();
```

### Custom Audio Formats

Override the default audio formats when needed:

```typescript
const agent = createAgent({
  stt: deepgram.stt({ model: "nova-3" }),
  tts: deepgram.tts({ model: "aura-2-thalia-en" }),
  llm: myLLMProvider,
  // Specify custom formats
  audio: {
    input: { encoding: "linear16", sampleRate: 24000, channels: 1 },
    output: { encoding: "linear16", sampleRate: 48000, channels: 1 },
  },
});
```

### Multi-language Support

```typescript
const stt = createDeepgramSTT({
  model: "nova-3",
  language: "es", // Spanish
});
```

See [Deepgram Languages](https://developers.deepgram.com/docs/languages) for supported languages.

## License

Apache-2.0
