# @talkio/deepgram Package

Deepgram STT and TTS providers for `talkio`. Uses Deepgram's WebSocket APIs for streaming.

**Key insight**: Provider implementation — wraps Deepgram's streaming APIs with type-safe interfaces.

## Structure

```
src/
├── deepgram-provider.ts  # Main factory (createDeepgram)
├── deepgram-stt.ts        # STT provider implementation
├── deepgram-tts.ts        # TTS provider implementation
├── types.ts               # Type definitions and interfaces
└── index.ts               # Public exports
```

## Core Concepts

### Provider Factory Pattern

Two ways to create providers:

**1. Provider Instance (Recommended):**

```typescript
const deepgram = createDeepgram({ apiKey: process.env.DEEPGRAM_API_KEY });
const stt = deepgram.stt({ model: "nova-3" });
const tts = deepgram.tts({ model: "aura-2-thalia-en" });
```

**2. Direct Imports:**

```typescript
import { createDeepgramSTT, createDeepgramTTS } from "@talkio/deepgram";
const stt = createDeepgramSTT({ apiKey: "...", model: "nova-3" });
const tts = createDeepgramTTS({ apiKey: "...", model: "aura-2-thalia-en" });
```

The provider instance pattern shares configuration (API key, base URL) across STT and TTS.

### Audio Format Support

**STT Input Formats:**

- **PCM**: `linear16` (8000, 16000, 24000, 48000 Hz), `linear32` (16000, 24000, 48000 Hz)
- **Compressed**: `flac`, `opus`, `ogg-opus` (various sample rates)
- **Speech codecs**: `speex`, `amr-nb`, `amr-wb`, `g729`
- **Telephony**: `mulaw`, `alaw` (8000 Hz)
- Default: `linear16` at 16000 Hz, mono

**TTS Output Formats:**

- `linear16` - 8000, 16000, 24000 (default), 32000, 48000 Hz
- `mulaw` - 8000 (default), 16000 Hz
- `alaw` - 8000 (default), 16000 Hz
- Default: `linear16` at 24000 Hz, mono

Providers are strongly typed with their supported formats, enabling compile-time validation.

### API Key Resolution

API key is resolved in this order:

1. Provider options (`createDeepgramSTT({ apiKey: "..." })`)
2. Provider settings (`createDeepgram({ apiKey: "..." })`)
3. Environment variable (`DEEPGRAM_API_KEY`)

Same resolution applies to `baseUrl`.

### WebSocket Connection Management

Both STT and TTS providers:

- Manage WebSocket lifecycle (connect, reconnect, close)
- Buffer audio before connection is ready
- Handle errors and emit via `ctx.error()`
- Support cancellation via `AbortSignal`

## Key Files

| File                   | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `deepgram-provider.ts` | Main factory (`createDeepgram()`)             |
| `deepgram-stt.ts`      | STT provider implementation                   |
| `deepgram-tts.ts`      | TTS provider implementation                   |
| `types.ts`             | Type definitions, options, WebSocket messages |
| `index.ts`             | Public exports                                |

## Patterns

### STT Provider Implementation

```typescript
export function createDeepgramSTT(
  options: DeepgramSTTOptions,
  providerSettings: DeepgramProviderSettings = {},
): STTProvider<DeepgramSTTInputFormat> {
  return {
    name: "DeepgramSTT",
    supportedInputFormats: SUPPORTED_INPUT_FORMATS,
    defaultInputFormat: DEFAULT_INPUT_FORMAT,
    start: (ctx) => {
      // WebSocket connection, transcript handling
      ctx.transcript(text, isFinal);
      ctx.speechStart();
      ctx.speechEnd();
    },
    stop: () => {},
    sendAudio: (audio) => {},
  };
}
```

### TTS Provider Implementation

```typescript
export function createDeepgramTTS(
  options: DeepgramTTSOptions,
  providerSettings: DeepgramProviderSettings = {},
): TTSProvider<DeepgramTTSOutputFormat> {
  return {
    name: "DeepgramTTS",
    supportedOutputFormats: SUPPORTED_OUTPUT_FORMATS,
    defaultOutputFormat: DEFAULT_OUTPUT_FORMAT,
    start: async (ctx) => {
      // Open the WebSocket session and keep it hot
      ctx.audioChunk(audio);
      ctx.complete();
    },
    speak: async (text) => {},
    flush: async () => {},
    clear: async () => {},
    stop: async () => {},
  };
}
```

### Adding New Audio Formats

1. Update encoding config in `deepgram-stt.ts` or `deepgram-tts.ts`:
   ```typescript
   const DEEPGRAM_STT_ENCODING_CONFIG = {
     linear16: { sampleRates: [8000, 16000, ...], channels: [1, 2] },
     // Add new encoding
   };
   ```
2. TypeScript will automatically generate supported formats via `generateSupportedFormats()`
3. Update types in `types.ts` if needed

## Configuration

### STT Options

- `model` (required) - STT model (e.g., "nova-3", "nova-2")
- `language` - Language code (default: "en")
- `interimResults` - Include partial transcripts (default: true)
- `punctuate` - Add punctuation (default: true)
- `smartFormat` - Apply smart formatting (default: true)
- `endpointing` - Silence threshold in ms (default: 300)
- `utteranceEndMs` - Wait time after speech (default: 1000)
- `keywords` - Words to boost recognition
- `vad` - Enable VAD events (default: true)

### TTS Options

- `model` (required) - TTS voice (e.g., "aura-2-thalia-en")
- `encoding` - Audio encoding (default: "linear16")
- `sampleRate` - Sample rate in Hz (default: 24000 for linear16, 8000 for mulaw/alaw)

## Integration with talkio

Providers implement the `STTProvider` and `TTSProvider` interfaces from `talkio`:

- Generic over format types (`STTProvider<DeepgramSTTInputFormat>`)
- Declare supported formats and defaults
- Receive context with emit methods and `AbortSignal`
- Report errors via `ctx.error()`, not throw

## Conventions

- Audio formats: strongly typed with compile-time validation
- WebSocket: automatic reconnection on errors
- Errors: reported via `ctx.error()`, not thrown
- AbortSignal: respected for cancellation
- Audio buffering: buffers chunks before connection ready

## Comments

**STRICT RULES - NEVER VIOLATE:**

- **NO decorative comments** — no banners, separators, or visual decorations
- **NO inline comments about changes** — never add comments like "// Changed this", "// Updated", "// Fixed", etc.
- **NO obvious comments** — don't comment what the code already clearly shows
- Comments should ONLY explain **why**, not **what** or **how**
- Only add comments when they provide non-obvious context or explain complex logic
- Prefer self-documenting code over comments
