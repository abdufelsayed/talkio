# Talkio

Pronounced "TAWK-yo" - like "Tokyo", but starting with "talk".

> **⚠️ Vibe-Engineered** — This package is **not production-ready**. Suitable for prototyping and experimentation. Expect API changes, rough edges, and non-idiomatic patterns. See the [Package Maturity Model](./PACKAGE-MATURITY.md) for details.

> **Alpha Release** — Under active development.

[![npm version](https://img.shields.io/npm/v/talkio.svg)](https://www.npmjs.com/package/talkio)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Voice AI orchestration for TypeScript** — pure orchestration, zero infrastructure lock-in.

Talkio is a voice agent orchestration library that coordinates STT, LLM, and TTS components with human-like turn-taking, interruption handling, and real-time streaming. It's designed to be the engine powering your voice AI applications, regardless of where the voice comes from or where you deploy.

- **TypeScript-first** — Built for the JavaScript ecosystem, runs anywhere JS runs
- **Voice source agnostic** — Works with phone, web, mobile, microphone, WebRTC
- **Provider agnostic** — BYO any STT/TTS/LLM, or create custom providers for self-hosted models
- **Zero infrastructure** — Pure library, no servers or infrastructure required
- **Human-like turn-taking** — Semantic end-of-turn detection, replies prepared before the user finishes, interruptions confirmed by words, fillers and backchannels

## At a Glance

- You bring: STT, LLM, and TTS providers (or custom implementations), optionally a VAD and a turn detector
- Talkio handles: turn-taking, interruptions, cancellation, and streaming coordination
- You consume: an event stream (transcripts, tokens/sentences, audio, and playback control)

## Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Why Talkio?](#why-talkio)
- [Architecture](#architecture)
- [Why Actors & State Machines?](#why-actors--state-machines)
- [Turn-Taking](#turn-taking)
- [Interruptions](#interruptions)
- [Playback](#playback)
- [Natural Conversation](#natural-conversation)
- [Handling the Hard Cases](#handling-the-hard-cases)
- [Comparison with Alternatives](#comparison-with-alternatives)
- [Deployment](#deployment)
- [Design Philosophy](#design-philosophy)
- [Streaming LLM Example](#streaming-llm-example)
- [Events](#events)
- [Packages](#packages)
- [Audio Configuration](#audio-configuration)
- [Creating Custom Providers](#creating-custom-providers)
- [Examples](#examples)
- [License](#license)

## Installation

```bash
npm install talkio
```

For provider packages:

```bash
npm install @talkio/deepgram
```

## Quick Start

This is the smallest useful setup: wire providers, listen to events, and stream audio in.

```typescript
import { createAgent } from "talkio";

const agent = createAgent({
  stt: mySTT,
  llm: myLLM,
  tts: myTTS,
  onEvent: (event) => {
    switch (event.type) {
      case "user-turn:ended":
        console.log("User:", event.text);
        break;
      case "agent-turn:audio":
        // Pipe to speakers / WebRTC / telephony, etc.
        playAudio(event.audio);
        break;
      case "audio:pause": // the user started talking over the agent
        pausePlayback();
        break;
      case "audio:resume": // it was not an interruption ("mm-hmm", a cough)
        resumePlayback();
        break;
      case "audio:clear": // it was: drop audio that has not played yet
        clearPlayback();
        break;
    }
  },
});

agent.start();
agent.sendAudio(audioChunk); // stream audio chunks as they arrive
// agent.stop();
```

`agent-turn:audio` events carry the same chunks as `agent.audioStream`; use whichever suits your transport.

For a complete runnable setup (WebSocket server + browser mic), see `examples/simple`.

## Why Talkio?

Building voice AI agents is deceptively complex. You need to coordinate multiple async streams — audio input, speech recognition, language model generation, speech synthesis, audio output — all while handling brittle edge cases:

- **Interruptions**: User speaks while agent is responding
- **Turn-taking**: Detecting when the user is done speaking vs. pausing to think
- **Latency**: Minimizing time-to-first-audio without sacrificing quality
- **Cancellation**: Cleaning up in-flight operations when context changes
- **Race conditions**: Multiple components generating events simultaneously

Existing solutions come with trade-offs:

| Approach              | Trade-off                                                 |
| --------------------- | --------------------------------------------------------- |
| **LiveKit Agents**    | Requires LiveKit Server infrastructure (SSL, TURN, Redis) |
| **Pipecat**           | Python-only, tied to Daily.co transport layer             |
| **OpenAI Agents SDK** | Locked to OpenAI Realtime API                             |
| **Managed platforms** | Per-minute costs, less flexibility                        |

**Talkio takes a different approach**: pure orchestration that runs anywhere JavaScript runs, with no opinions on infrastructure, transport, or providers. Use it as the engine for any voice agent implementation.

## Architecture

Talkio uses a state machine architecture built on [XState](https://xstate.js.org/) with parallel actors:

```
Audio In → [VAD] ───────────┐
         → [STT] ───────────┼→ turn-taking → [LLM] → [TTS] → [Audio Streamer] → Audio Out
         → [Turn Detector] ─┘
```

**Six specialized actors** run in parallel with event-based communication:

| Actor              | Responsibility                                                           |
| ------------------ | ------------------------------------------------------------------------ |
| **STT Actor**      | Speech-to-text; some providers also detect turns (Deepgram Flux)         |
| **VAD Actor**      | Voice activity detection (optional, falls back to STT speech events)     |
| **Turn Detector**  | Semantic end-of-turn detection, by decision or by probability (optional) |
| **LLM Actor**      | Response generation; splits streamed tokens into sentences               |
| **TTS Actor**      | Sentence-level synthesis, with optional word timings                     |
| **Audio Streamer** | Pull-based output stream that drops unread audio of interrupted turns    |

**Parallel regions** model both sides of the conversation at once:

```
idle → running → stopped
         ├── input        silent ↔ active      is anyone speaking (VAD, or the STT)
         ├── human        idle ↔ active        the user's turn: speaking ↔ paused
         ├── ai           idle → preparing → responding
         │                          live ↔ contested ↔ held (overlapping speech)
         ├── backchannel  idle ↔ speaking      "mm-hmm" while the user talks
         └── silence      idle ↔ waiting       prompts a user who went quiet
```

The human region decides when the user's turn ends. The ai region owns the reply, including speech that overlaps it, and only hands the floor to the user once that speech turns out to be an interruption.

## Why Actors & State Machines?

Voice AI involves complex concurrent operations that must coordinate precisely. Traditional async/await patterns quickly become unmanageable with multiple parallel streams, cancellation requirements, and edge cases.

**XState actors provide**:

- **Isolated state per component** — No shared mutable state between STT, LLM, TTS
- **Event-driven communication** — Clean boundaries, explicit message passing
- **Automatic cleanup** — AbortSignal propagation for graceful cancellation
- **Visual debugging** — [XState Inspector](https://stately.ai/docs/inspector) for real-time state visualization

**Practical benefits**:

- Predictable behavior under complex scenarios (interruptions, errors, timeouts)
- Easy to add custom providers — just implement the interface
- Testable transitions — state changes are explicit and observable

## Turn-Taking

Knowing when the user has finished matters more than anything else for how human an agent feels. Answer too early and it talks over people who pause to think; too late and every reply drags. Talkio picks the turn source from your providers:

| Providers                        | The turn ends                                                               |
| -------------------------------- | --------------------------------------------------------------------------- |
| STT only (default)               | On each final transcript                                                    |
| STT with native turn detection   | When the STT reports the end, e.g. [`deepgram.flux()`](./packages/deepgram) |
| Turn detector                    | After a pause that shrinks as the detector's end-of-turn probability grows  |
| Turn detector, `decision` output | When the detector calls `ctx.turn.end()`                                    |

A configured turn detector takes precedence over the STT's own turn signals.

### Semantic turn detection

A turn detector scores each pause: how likely is it that the user is done? The agent waits accordingly: `minDelayMs` of silence when the detector is confident, up to `maxDelayMs` when it expects more. "My number is 555..." gets time to continue; "Thanks, that's all." gets a quick answer.

The simplest detector is a function. It gets the turn's transcript and the conversation before it, since what the agent just asked changes what counts as a complete answer:

```typescript
const agent = createAgent({
  stt,
  llm,
  tts,
  vad,
  turnDetector: ({ transcript, messages, signal }) => model.score(transcript, messages, { signal }),
  turnTaking: {
    eagerness: "medium", // 400ms–2.5s; "high" is snappier (200ms–1.2s), "low" waits longer (800ms–5s)
    threshold: 0.7, // probability at which the detector counts as confident
  },
});
```

It is called when the user pauses, and again if the transcript changes during the pause. `signal` aborts when the user resumes; a result that arrives after that is ignored.

Detectors that read audio, load a model, or stream are objects, and implement only what they need:

```typescript
import type { TurnDetector } from "talkio";

const smartTurn: TurnDetector = {
  name: "SmartTurn",
  async start(ctx) {
    model = await loadModel(); // a rejected promise is reported as an agent:error
    window = new AudioWindow(ctx.audioFormat, { seconds: 8 });
  },
  sendAudio: (audio) => window.push(audio),
  onPause: ({ signal }) => model.predict(window.samples(), { signal }),
};
```

A detector can also report through `ctx.turn` whenever it likes: `probability(p)`, `end()`, `eagerEnd()`, `resumed()` and `abandoned(reason)`. One that decides on its own sets `output: "decision"`, and the agent waits for its `end()`.

Pass several detectors to combine them, for example one that reads prosody and one that reads words. The highest probability counts:

```typescript
createAgent({ stt, llm, tts, turnDetector: [smartTurn, textModel] });
```

### Preemptive generation

When the user has probably finished, signalled by `eagerEnd` or by a probability at or above `eagerThreshold` (default 0.5), the agent starts the LLM and TTS right away and holds the output. If the turn ends as predicted, the reply is ready instantly; if the user keeps talking, it is discarded. It is on by default (`turnTaking.preemptiveGeneration`).

A speculative generation can be thrown away, so wait until the turn is confirmed before side effects:

```typescript
const llm: LLMFunction = async (ctx) => {
  // ...stream the reply; before a tool call that books, buys, or sends something:
  if (!(await ctx.turnConfirmed())) return; // the user kept talking
  await bookFlight(details);
};
```

## Interruptions

When the user starts talking over the agent, the agent does not stop blindly. It pauses (`audio:pause`) and listens:

- **Words confirm an interruption**: enough words in an interim transcript (fewer in a final one), or a cue such as "stop", "wait" or "actually". The agent yields with `agent-turn:interrupted`, and `audio:clear` tells the client to drop what it has not played.
- **Everything else is not one**: acknowledgements ("mm-hmm", "okay", "right"), the agent's own voice picked up by the microphone, and sounds without words (a cough, a TV). The agent resumes where it paused (`audio:resume`) and emits `agent-turn:interruption-cancelled` with the reason.

```typescript
createAgent({
  stt,
  llm,
  tts,
  interruption: {
    minDurationMs: 200, // shorter sounds are false starts
    minWords: 2, // words an interim transcript needs to interrupt
    resumeAfterMs: 600, // after the user stops, wait this long for a late transcript
    maxPendingMs: 3000, // resume after this long without words
    pendingAudio: "pause", // or "clear" for transports that can only flush their buffer
  },
});
```

Interruptions are on by default; `interruption: false` turns them off.

The built-in classifier works from phrases, word counts, and overlap with what the agent was saying. Replace it with `interruption.classifier`, which returns `"interrupt"`, `"backchannel"`, `"echo"`, or `"undecided"` (wait for more words), synchronously or as a promise:

```typescript
interruption: {
  classifier: ({ transcript, agentText, isFinal }) => myModel.classify(transcript, agentText, isFinal),
},
```

**Hearing itself.** Use echo cancellation on the client: browsers and phones do it by default. Without it, the microphone picks up the agent. The agent ignores transcripts that only repeat what it just said (a backchannel, or the end of a reply) for about 1.5 seconds after that audio plays. The echo still counts as voice activity, though, and an STT with its own turn detection may fold it into the user's turn.

`agent-turn:interrupted` reports `heardText`, the part of the reply the user actually heard. The conversation history keeps only that part, so the LLM knows where it was cut off.

## Playback

For PCM and telephony encodings, the agent tracks playback. It assumes audio plays in real time once released, and that playback holds while paused. From this it works out `heardText`, and it emits `agent-turn:ended` once the audio has played rather than when synthesis finishes. To make it exact:

- Report the client's progress with `agent.reportPlayback({ turnId, playedMs })` when it buffers or plays late.
- Set `playback.outputLatencyMs` to the network and jitter-buffer delay.
- Use a TTS provider that reports word timings (`ctx.wordTimings`); otherwise heard text is estimated from an even speech rate.

## Natural Conversation

### Fillers

When a reply is slow to start, for example while the LLM calls tools, the agent can fill the silence:

```typescript
createAgent({
  stt,
  llm,
  tts,
  fillers: { afterMs: 1200, phrases: ["One moment.", "Let me check."] },
});
```

Fillers, backchannels and silence prompts are off by default. Pass options to turn one on, or `true` for its defaults: `fillers: true`.

Fillers are never part of the reply text, the history, or `heardText`. If the user talks during the wait, the wait starts over. Configured filler and backchannel phrases are synthesized once and their audio replayed after that, so they play without waiting for the TTS. Text the LLM passes to `ctx.say()` varies, so it is always synthesized.

For fillers that say what is happening, call `ctx.say()` from the LLM. Here is an example with the [Vercel AI SDK](https://ai-sdk.dev)'s `fullStream`:

```typescript
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const llm: LLMFunction = async (ctx) => {
  const result = streamText({
    model: openai("gpt-4o"),
    messages: ctx.messages,
    tools: {
      getWeather: {
        /* ... */
      },
      searchFlights: {
        /* ... */
      },
    },
    abortSignal: ctx.signal,
  });

  for await (const event of result.fullStream) {
    switch (event.type) {
      case "tool-call":
        if (event.toolName === "getWeather") {
          ctx.say(`Checking the weather in ${event.args.location}...`);
        } else if (event.toolName === "searchFlights") {
          ctx.say("Looking up available flights for you...");
        }
        break;

      case "text-delta":
        ctx.token(event.textDelta);
        break;
    }
  }

  ctx.complete();
};
```

The user hears _"Checking the weather in Tokyo..."_ instead of silence during tool execution. `ctx.interrupt()` stops a filler that is no longer needed.

### Backchannels

While the user talks at length, the agent can say "mm-hmm" in pauses that are probably mid-thought, the way an attentive listener does:

```typescript
createAgent({
  stt,
  llm,
  tts,
  vad,
  turnDetector, // backchannels need end-of-turn probabilities
  backchannels: {
    minSpeechMs: 4000, // user speech before each backchannel
    pauseMs: 400, // pause length that invites one
    maxEndOfTurnProbability: 0.3, // only when the user is likely to continue
  },
});
```

Each backchannel emits `agent:backchannel`, and its audio arrives as `agent-turn:audio` with the backchannel's `turnId`. If the user starts talking again before a backchannel has started playing, the agent drops it rather than say it over their next sentence. The probabilities can come from a turn detector or from an STT provider with native turn detection, such as Deepgram Flux.

### Greetings and silence prompts

`agent.say()` speaks fixed text without calling the LLM, and records it in the history:

```typescript
agent.start();
agent.say("Hi, this is Ava from Acme. How can I help?");
```

The `silence` config prompts a user who has gone quiet:

```typescript
createAgent({
  stt,
  llm,
  tts,
  silence: { afterMs: 8000, prompt: "Are you still there?", maxPrompts: 2 },
});
```

## Handling the Hard Cases

### Cancellation

AbortSignal flows through all actors. When the user interrupts:

1. The LLM generation is cancelled
2. TTS synthesis is cleared
3. Unread audio in `audioStream` is discarded, and `audio:clear` tells the client to drop what it buffered
4. The history keeps only what the user heard

### Timeouts

Optional timeouts stop a provider that hangs. They are off by default:

```typescript
createAgent({ stt, llm, tts, timeout: { llmMs: 30_000, ttsMs: 10_000 } });
```

### Sentence-Level Streaming

The agent splits the LLM's tokens into sentences and starts TTS on the first one, so the user hears the reply while the rest is still being generated. Providers that know better can report sentences themselves with `ctx.sentence()`. Audio waits in the pull-based `audioStream` until it is read, up to 16 MB, beyond which the oldest chunks are dropped.

### Built-in Metrics

Comprehensive observability without external tooling:

```typescript
const state = agent.getSnapshot();

// Latency metrics
state.metrics.latency.averageTimeToFirstToken; // LLM latency
state.metrics.latency.averageTimeToFirstAudio; // End-to-end latency
state.metrics.latency.averageTurnDuration;

// Turn tracking
state.metrics.turns.total;
state.metrics.turns.completed;
state.metrics.turns.interrupted;

// Error tracking by source
state.metrics.errors.bySource; // { stt: 0, llm: 1, tts: 0, vad: 0, turnDetector: 0 }
```

For per-turn detail, pass `onTrace` to receive timestamped trace events (LLM first token, TTS first audio, interruption timing, and so on).

## Comparison with Alternatives

### Orchestration Libraries

| Feature              | Talkio                 | LiveKit Agents                      | Pipecat             | OpenAI Agents SDK |
| -------------------- | ---------------------- | ----------------------------------- | ------------------- | ----------------- |
| **Language**         | TypeScript             | Python/TypeScript                   | Python              | TypeScript        |
| **Infrastructure**   | None                   | LiveKit Server + SSL + TURN + Redis | Transport layer     | None              |
| **LLM Integration**  | BYO any SDK            | Built-in                            | Built-in plugins    | OpenAI only       |
| **Provider Lock-in** | None                   | LiveKit ecosystem                   | Daily.co ecosystem  | OpenAI models     |
| **Custom Providers** | First-class            | Plugins                             | Plugins             | No                |
| **Filler Phrases**   | `fillers`, `ctx.say()` | `session.say()` in hooks            | Manual              | Unknown           |
| **Voice Source**     | Agnostic               | WebRTC rooms                        | Transport-dependent | Agnostic          |

**When to use each**:

- **Talkio**: TypeScript projects, maximum flexibility, no infrastructure
- **LiveKit Agents**: Already using LiveKit, need WebRTC rooms
- **Pipecat**: Python projects, need 40+ provider integrations
- **OpenAI Agents SDK**: Using OpenAI Realtime API, want guardrails/handoffs

### Managed Platforms

Talkio is not a managed platform — it's a library. Managed platforms like Vapi, Retell, and Bland AI handle everything (hosting, scaling, telephony) but with per-minute costs and less flexibility. Talkio could power the backend of such platforms.

| Aspect             | Talkio            | Managed Platforms |
| ------------------ | ----------------- | ----------------- |
| **Pricing**        | Free (Apache-2.0) | Per-minute fees   |
| **Infrastructure** | You manage        | They manage       |
| **Flexibility**    | Maximum           | Limited           |
| **Deployment**     | Anywhere          | Their cloud       |

## Deployment

Talkio is a pure library — no infrastructure requirements.

### Runtime Agnostic

```typescript
// Bun
Bun.serve({
  /* ... */
});

// Node.js
import { createServer } from "http";

// Deno
Deno.serve({
  /* ... */
});

// Edge (Cloudflare Workers, Vercel Edge, etc.)
export default {
  fetch(req) {
    /* ... */
  },
};
```

### Transport Agnostic

```typescript
// WebSocket
ws.on("message", (data) => agent.sendAudio(data));

// WebRTC (via external library)
peerConnection.ontrack = (e) => {
  /* pipe to agent */
};

// HTTP streaming
const reader = request.body.getReader();
```

### Platform Agnostic

Deploy anywhere JavaScript runs:

- Cloudflare Workers
- Vercel Edge Functions
- AWS Lambda
- Google Cloud Functions
- Bare metal servers
- Local development

## Design Philosophy

### Why No Built-in LLM?

Talkio provides an `LLMFunction` interface instead of bundling LLM clients. This gives you:

- **Choice**: Use Vercel AI SDK, OpenAI SDK, Anthropic SDK, or any other client
- **Control**: Full access to streaming, tool calls, and model-specific features
- **Future-proof**: Swap models without changing orchestration code

```typescript
// With Vercel AI SDK
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

// Return the text stream; the agent speaks it and completes the turn
const llm: LLMFunction = (ctx) =>
  streamText({ model: openai("gpt-4o"), messages: ctx.messages, abortSignal: ctx.signal })
    .textStream;

// With Anthropic SDK
import Anthropic from "@anthropic-ai/sdk";

const llm: LLMFunction = async (ctx) => {
  const stream = anthropic.messages.stream(
    { model: "claude-sonnet-4-5", max_tokens: 1024, messages: ctx.messages },
    { signal: ctx.signal },
  );
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      ctx.token(event.delta.text);
    }
  }
  ctx.complete();
};
```

### Why XState?

Voice AI has inherently complex state. XState provides:

- Predictable async state management
- Built-in support for parallel states (STT, LLM, TTS running simultaneously)
- Clean cancellation patterns
- Devtools for debugging complex state flows

### Why Separate Provider Packages?

Providers are tree-shakeable. Only bundle what you use:

```bash
npm install talkio           # Core orchestration
npm install @talkio/deepgram       # Deepgram STT/TTS
# More providers coming...
```

## Streaming LLM Example

```typescript
import { createAgent, type LLMFunction } from "talkio";
import { createDeepgram } from "@talkio/deepgram";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const deepgram = createDeepgram({ apiKey: process.env.DEEPGRAM_API_KEY });

// The agent splits the stream into sentences for TTS and completes the turn when it ends
const llm: LLMFunction = (ctx) =>
  streamText({ model: openai("gpt-4o-mini"), messages: ctx.messages, abortSignal: ctx.signal })
    .textStream;

const agent = createAgent({
  stt: deepgram.stt({ model: "nova-3" }),
  llm,
  tts: deepgram.tts({ model: "aura-2-thalia-en" }),
  onEvent: (event) => {
    switch (event.type) {
      case "user-turn:ended":
        console.log("User:", event.text);
        break;
      case "agent-turn:audio":
        playAudio(event.audio);
        break;
    }
  },
});

agent.start();
agent.sendAudio(audioChunk); // Float32Array from microphone
agent.stop();
```

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

Every event carries a `timestamp`, and turn events carry a `turnId`.

## Packages

| Package            | Description                                                     | Status    |
| ------------------ | --------------------------------------------------------------- | --------- |
| `talkio`           | Core orchestration library                                      | Available |
| `@talkio/deepgram` | Deepgram STT (Nova and Flux) and TTS providers                  | Available |
| `@talkio/testkit`  | Scenarios, fake providers, invariants, and provider conformance | Available |

More provider packages coming soon.

See [Package Maturity Model](./PACKAGE-MATURITY.md) for information about package maturity levels and current status.

## Audio Configuration

Configure separate input/output formats, or use provider defaults:

```typescript
const agent = createAgent({
  stt: mySTT,
  llm: myLLM,
  tts: myTTS,
  // Optional: specify audio formats (uses provider defaults if omitted)
  audio: {
    input: { encoding: "linear16", sampleRate: 16000, channels: 1 },
    output: { encoding: "linear16", sampleRate: 24000, channels: 1 },
  },
});
```

Conversion helpers for clients and transports (`float32ToLinear16`, `resample`, `mulawToLinear16`, ...) are in `talkio/audio`:

```typescript
import { float32ToLinear16, resample } from "talkio/audio";
```

### Supported Encodings

| Category   | Encodings                                |
| ---------- | ---------------------------------------- |
| PCM        | `linear16`, `linear32`, `float32`        |
| Telephony  | `mulaw`, `alaw`                          |
| Compressed | `opus`, `ogg-opus`, `flac`, `mp3`, `aac` |
| Container  | `wav`, `webm`, `ogg`, `mp4`              |

## Creating Custom Providers

Create providers for self-hosted models or services not yet supported:

```typescript
import { createLLM, createSTT, createTTS, createVAD } from "talkio";

// Custom STT provider
const sttFormats = [{ encoding: "linear16", sampleRate: 16000, channels: 1 }] as const;

const stt = createSTT({
  name: "MySTT",
  supportedInputFormats: sttFormats,
  defaultInputFormat: sttFormats[0],
  start: (ctx) => {
    // ctx.audioFormat - the selected input format
    // ctx.transcript(text, isFinal)
    // ctx.speechStart(), ctx.speechEnd()
    // ctx.turn.end(), ctx.turn.eagerEnd(), ctx.turn.probability(p), ... - with turnDetection: true
    // ctx.signal - AbortSignal for cancellation
  },
  stop: () => {},
  sendAudio: (audio) => {},
});

// Custom LLM provider
const llm = createLLM({
  name: "MyLLM",
  generate: async (ctx) => {
    // return a stream of text, or report through the context:
    // ctx.messages - the conversation
    // ctx.token(text) - stream tokens; the agent splits them into sentences
    // ctx.sentence(text, index) - optional: report sentences yourself
    // ctx.complete() - signal completion
    // ctx.say(text) - speak a filler now
    // ctx.interrupt() - stop a filler
    // ctx.isSpeaking() - check if agent is speaking
    // ctx.isSpeculative(), ctx.turnConfirmed() - preemptive generation
    // ctx.signal - AbortSignal
  },
});

// Custom TTS provider
const ttsFormats = [{ encoding: "linear16", sampleRate: 24000, channels: 1 }] as const;

const tts = createTTS({
  name: "MyTTS",
  supportedOutputFormats: ttsFormats,
  defaultOutputFormat: ttsFormats[0],
  start: async (ctx) => {
    // ctx.audioFormat - the selected output format
    // ctx.audio(buffer) - stream audio chunks
    // ctx.wordTimings(words) - optional: when each word is spoken
    // ctx.complete() - signal completion
    // ctx.signal - AbortSignal
  },
  speak: async (text) => {},
  flush: async () => {},
  clear: async () => {},
  stop: async () => {},
});

// Custom VAD provider
const vad = createVAD({
  name: "MyVAD",
  start: (ctx) => {
    // ctx.audioFormat - the agent's input format
    // ctx.speechStart(), ctx.speechEnd(durationMs?) - the agent times speech when omitted
    // ctx.probability(p) - optional, emitted as vad:probability
  },
  stop: () => {},
  sendAudio: (audio) => {},
});
```

Turn detectors are plain functions or objects (see [Turn-Taking](#turn-taking)). Check custom providers against their contracts with the conformance assertions in `@talkio/testkit`, such as `assertSTTProviderConformance`.

## Examples

See the [`/examples`](./examples) directory for complete working examples:

- [`simple`](./examples/simple) — WebSocket server with Deepgram and OpenAI

## License

Apache-2.0
