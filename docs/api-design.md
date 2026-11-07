# API Design

Talkio's public API before the first stable release: the principles it follows, and the changes that bring today's API in line with them. Talkio is in alpha, so these are breaking changes made once, without deprecation shims.

## Principles

- **The core is a skeleton for providers.** Providers own how to sense (models, sockets, resampling, vendor thresholds); the core owns what to do (turn-taking, interruptions, playback, the timeline, running tools). The core never knows which vendor produced a signal. If a provider package needs a core change to work, the boundary is wrong.
- **Progressive disclosure.** No configuration gives a sensible agent. Each extra need costs one small step, and adding one never means rewriting what was there.
- **Plain values over ceremony.** A function before a provider object, `true` before `{ enabled: true }`, an array before a combinator.
- **One vocabulary.** The words of the domain (user, agent, turn, pause, probability), not of the implementation (commit, decision mode, human/AI). The same idea has the same name everywhere.
- **Types guide; bad configuration fails at creation**, not in the middle of a call.
- **Only what users need is public.** Internal types and helpers are not exported.
- **Users compose models and write tools.** Everything else has a default: when to speak, how to hand work over, and how the models see the conversation are the core's job.

## Signal layers

Hearing the user splits into three layers, each a separate slot:

| Layer         | Question                           | Slot           | Examples                                    |
| ------------- | ---------------------------------- | -------------- | ------------------------------------------- |
| Acoustic      | Is someone making sound?           | `vad`          | Silero, WebRTC VAD, the STT's own events    |
| End of turn   | How likely is it the user is done? | `turnDetector` | Smart Turn (audio), LiveKit EOU (text)      |
| Policy (core) | So what do we do now?              | `turnTaking`   | delays, preemptive generation, backchannels |

STT providers with built-in turn detection (Deepgram Flux, AssemblyAI) report through the same signals. Precedence is one rule: **a configured `turnDetector` decides; otherwise the STT's own turn signals; otherwise final transcripts.** An STT package that wants its turn signals combined with other detectors exposes them as a detector (`flux.turnDetector`).

```ts
// Defaults: the STT's endpointing ends turns
createAgent({ stt: deepgram.stt(), talker, tts });

// One line per capability
createAgent({ stt: deepgram.stt(), vad: silero(), turnDetector: smartTurn(), talker, tts });

// STT with built-in turn detection
createAgent({ stt: deepgram.flux(), talker, tts });

// Several detectors: the highest end-of-turn probability counts
const flux = deepgram.flux();
createAgent({ stt: flux, turnDetector: [flux.turnDetector, smartTurn()], talker, tts });

// Your own text model, as a function
createAgent({
  stt,
  talker,
  tts,
  turnDetector: ({ transcript, timeline, signal }) =>
    myModel.score(transcript, timeline, { signal }),
});
```

## Changes

### Turn detection

A turn detector is a function, a provider object, or an array of them.

```ts
type TurnDetectorInput =
  | TurnDetectorFunction
  | TurnDetector
  | readonly (TurnDetectorFunction | TurnDetector)[];

/** Called when the user pauses. Returns how likely it is (0–1) that they are done. */
type TurnDetectorFunction = (pause: Pause) => number | Promise<number>;

interface Pause {
  transcript: string;
  timeline: readonly TimelineEntry[];
  /** Aborts when the user resumes; a result that arrives after is ignored. */
  signal: AbortSignal;
}

interface TurnDetector {
  name?: string;
  /** `"probability"`: the core decides when the turn ends. `"decision"`: the detector calls `ctx.turn.end()`. @default "probability" */
  output?: "probability" | "decision";
  start?(ctx: TurnDetectorContext): void | Promise<void>;
  stop?(): void;
  onPause?: TurnDetectorFunction;
  sendAudio?(audio: ArrayBuffer): void;
  onTranscript?(text: string, isFinal: boolean): void;
  onSpeechStart?(): void;
}
```

| Today                                                                                           | Proposed                                                       | Why                                                                                             |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Provider object only                                                                            | Function, object, or array                                     | A text model is one function; combining detectors is a list.                                    |
| `onSpeechEnd(duration)` + `onContext(messages)`, then report                                    | `onPause(pause)` returns the probability                       | Detectors stop keeping their own transcript and history; stale results are dropped by the core. |
| `mode: "decision" \| "prediction"`, default `"decision"`                                        | `output: "probability" \| "decision"`, default `"probability"` | Names what the detector emits; models emit probabilities.                                       |
| `onAudio(audio)`                                                                                | `sendAudio(audio)`                                             | One name for audio going to a provider (STT, VAD, detector).                                    |
| `createCustomTurnDetectorProvider` with required `start`, `stop`, `onSpeechEnd`, `onTranscript` | A plain object; every member optional                          | A detector implements only what it reads, with no factory.                                      |
| Signals spread on the context (`ctx.turnEnd`, ...)                                              | Under `ctx.turn`, as for STT                                   | One shape for turn signals everywhere.                                                          |

Audio is not part of `Pause`: audio models keep the window they need (length, sample rate) from `sendAudio`, which is model-specific.

### Turn signals

Used by STT providers and decision detectors as `ctx.turn.*`.

| Today                      | Proposed                |
| -------------------------- | ----------------------- |
| `turnEnd(transcript)`      | `end(transcript?)`      |
| `eagerTurnEnd(transcript)` | `eagerEnd(transcript?)` |
| `turnResumed()`            | `resumed()`             |
| `turnAbandoned(reason)`    | `abandoned(reason)`     |
| `endOfTurnProbability(p)`  | `probability(p)`        |

The transcript is optional: the core already assembles it from the STT.

### LLM

```ts
// Return a stream of text: the core reports tokens, completes, and reports a thrown error
talker: (ctx) => streamText({ model, messages: ctx.messages, abortSignal: ctx.signal }).textStream;

// Or drive it by hand
talker: async (ctx) => {
  for await (const token of stream) ctx.token(token);
  ctx.complete();
};
```

| Today                                     | Proposed                                        | Why                                                                 |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `LLMFunction` returns `void`              | May return `AsyncIterable<string>` or a promise | Any streaming SDK plugs in with one line; rejections become errors. |
| `complete(fullText)`                      | `complete(text?)`                               | The core already has the tokens.                                    |
| `waitForCommit()`                         | Removed                                         | The core holds a speculative turn's `think` calls until it commits. |
| `LLMProvider.generate(messages, ctx)`     | `generate(ctx)`                                 | `ctx.messages` already holds them.                                  |
| `isLLMProvider`, `isLLMFunction` exported | Internal                                        | Only the core needs them.                                           |

### Providers

| Today                                                     | Proposed                                           | Why                                                     |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `createCustomSTTProvider`, `createCustomTTSProvider`, ... | `createSTT`, `createTTS`, `createVAD`, `createLLM` | Shorter, and they read like `createAgent`.              |
| `metadata.type`, `version` on every provider              | Removed                                            | The slot says the type; versions are in `package.json`. |
| `VADProvider.processAudio`, `TurnDetector.onAudio`        | `sendAudio`                                        | One name, as on STT.                                    |
| `VADContext.speechEnd(duration)`                          | `speechEnd(durationMs?)`                           | The core times speech when the VAD does not report it.  |
| `VADContext.speechProbability(p)`                         | `probability(p)`                                   | Shorter in context.                                     |
| `VADContext` has no audio format                          | `ctx.audioFormat`                                  | A model has to know what it is reading.                 |
| `TTSContext.audioChunk(audio)`                            | `audio(audio)`                                     | Shorter in context.                                     |

### Talker and thinker

A voice agent needs a fast model to talk and a strong model to work, and the two must not wait on each other. The agent is one mind with a fast foreground and background work, over one append-only timeline:

```ts
createAgent({
  stt,
  tts,
  talker: aiSdk(anthropic("claude-haiku-5-5")),
  thinker: aiSdk(anthropic("claude-opus-5-5")),
  instructions: "You are Ava, the receptionist at Acme Dental.",
  tools: { findAppointment, bookAppointment },
});
```

| Before                                                        | Now                                                                     | Why                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `llm`, with tools run inside the provider                     | `talker`, `thinker`, `tools`, `instructions`                            | Tools ran inside the reply, so talking waited on working. The core now owns tools and runs them in the background.                               |
| A turn owns all work; interrupting it cancels its tool calls  | The thinker's work outlives turns; only the talker's reply is cancelled | The user still wants what they asked for after they talk over the acknowledgement.                                                               |
| `messages: Message[]`, one assistant message per turn         | `timeline: TimelineEntry[]`, append-only                                | Results arrive between turns. One ordered log lets both models see cause and effect, keeps prompts cacheable, and records where the user cut in. |
| `fillers`, `ctx.say()`, `ctx.interrupt()`, `ctx.isSpeaking()` | Removed                                                                 | They patched a slow model doing two jobs. A fast talker acknowledges in its own words.                                                           |
| `silence.prompt`                                              | Removed; a silence wakes the talker                                     | The talker knows whether work is open and words the prompt itself.                                                                               |
| `ctx.isSpeculative()`, `ctx.turnConfirmed()`                  | Removed                                                                 | The core holds `think` calls from a speculative reply until the turn commits, so no tool runs for a turn the user did not finish.                |
| `maxMessages`                                                 | Removed                                                                 | The timeline is the record; compaction comes when long sessions need it.                                                                         |
| `timeout.llmMs`, `agent:error.source: "llm"`                  | `timeout.talkerMs`, `source: "talker" \| "thinker"`                     | Two models fail separately.                                                                                                                      |

How it works:

- **Primitives.** The timeline; the floor (who is speaking, the user always wins); talker runs; and thinker runs.
- **The talker just talks.** Its one tool is `think(request)`, answered at once with "Started." so it acknowledges in the same turn. It sees everything on the timeline, tool inputs and outputs included, and answers follow-ups from them.
- **One thinker.** It reads the whole timeline at every step, so new requests and corrections ("make it Saturday", "never mind") reach it without a cancel verb. Its text goes on the timeline; its questions and findings are told by the talker.
- **The core decides when.** The talker wakes when the user's turn ends, or when the thinker writes, fails, or a silence lands while nobody is speaking. A run that follows new thinker text gets a note, not saved, to tell the user; fast models otherwise skip late results.
- **Provider-portable encoding.** Each model sees its own tool calls as native tool calls and everything else as tagged text. Providers reject tool calls the request did not declare and require each result to follow its call, so another model's calls cannot be native.
- `agent.say()` stays as the one way to speak exact text.

### Agent configuration

```ts
createAgent({
  stt,
  talker,
  tts,
  backchannels: true,
  silence: { afterMs: 8000 },
  turnTaking: { eagerness: "low" },
  interruption: { minWords: 3 },
  onEvent,
});
```

| Today                                                                 | Proposed                                          | Why                                         |
| --------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `backchannels: { enabled: true }`, same for `silence`, `interruption` | `true`, `false`, or options; options mean enabled | Turning a feature on is one word.           |
| `turnTaking.minEndOfTurnDelayMs` / `maxEndOfTurnDelayMs`              | `minDelayMs` / `maxDelayMs`                       | The section already says what the delay is. |
| `turnTaking.endOfTurnThreshold` / `eagerEndOfTurnThreshold`           | `threshold` / `eagerThreshold`                    | Same.                                       |
| `interruption.speculativeCutoffMs`                                    | `pauseAfterMs`                                    | Says what happens.                          |
| `interruption.interimMinWords` / `interimMinChars`                    | `minWords` / `minChars`                           | Shorter.                                    |
| `silence.timeoutMs`                                                   | `afterMs`                                         | Says when.                                  |
| `observability: { level: "trace", onTrace }`                          | `onTrace`                                         | Passing a handler is the switch.            |
| `simulatedClock`                                                      | `clock`                                           | Not only for simulation.                    |

### Events

| Today                                                                                                                          | Proposed                                             | Why                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `human-turn:*`, `ai-turn:*`                                                                                                    | `user-turn:*`, `agent-turn:*`                        | Messages say `user`; the library calls itself an agent. `agent:backchannel` stays: a backchannel is not a turn. |
| `human-turn:ended.transcript`, `ai-turn:ended.text`                                                                            | `text` on both                                       | One name.                                                                                                       |
| `ai-turn:interrupted` with `partialText`, `generatedText`, `audioStartedText`, `audioCompletedText`, `heardText`, `spokenText` | `generatedText`, `heardText`                         | Two are duplicates; the others are in traces. What was heard is what goes to history.                           |
| `ai-turn:interruption-pending.partialText` and `-cancelled.partialText`                                                        | `generatedText`                                      | Same name as on `interrupted`.                                                                                  |
| `turnId?` optional                                                                                                             | Required on turn events                              | Every turn event has one.                                                                                       |
| `agent:error.source`: `stt`, `llm`, `tts`, `vad`                                                                               | Adds `turnDetector`, as in `metrics.errors.bySource` | Detector errors are reported today only in debug logs.                                                          |

### Agent instance and state

| Today                                                      | Proposed                                   | Why                                                                 |
| ---------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `AgentState.value` (XState state value), `output`          | Removed                                    | Expose the implementation; `timeline` already has the conversation. |
| `AgentState.isRunning`, and `status` as the actor's status | `status: "idle" \| "running" \| "stopped"` | One field, in the agent's terms.                                    |
| `AgentState.partialTranscript` (the latest interim only)   | `transcript`                               | What the user has said in the current turn, final and interim.      |

### Exports

- Removed from the root: `NormalizedAgentConfig`, `NormalizedAudioConfig`, `Resolved*Config`, `normalizeAudioConfig`, `normalizeFormat`, `DEFAULT_AUDIO_*`, `ProviderType`, `BaseProvider`, `isLLMProvider`, `isLLMFunction`.
- Audio utilities (`resample`, `mulawToLinear16`, `normalizeFormat`, ...) move to `talkio/audio`, which replaces `talkio/audio/conversions`.

### Deepgram

| Today                                     | Proposed                                        | Why                                                    |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `deepgram.stt({ model })`, model required | `deepgram.stt()` defaults to `nova-3`           | Defaults should work.                                  |
| `deepgram.tts({ model })`, model required | `deepgram.tts()` defaults to `aura-2-thalia-en` | Same.                                                  |
| Flux turn signals only end turns          | Also `flux.turnDetector`                        | Combine Flux with other detectors without a core flag. |

## Not changing

- `agent.start/stop/sendAudio/say/reportPlayback`, `audioStream`, `subscribe`, `getSnapshot`.
- The `audio: { input, output }` configuration and its type narrowing per provider.
- `interruption.classifier` and the exported `classifyInterruption`.
- `audio:pause`, `audio:resume`, `audio:clear`, and the `ai-turn:audio` payload (renamed with its group).

## Order of work

1. Turn detection: function, array and `onPause`; `output`; `ctx.turn` signal names; `sendAudio`.
2. LLM: iterable return, `complete(text?)`, `turnConfirmed()`, `generate(ctx)`.
3. Providers: `create*` factories, metadata, VAD context.
4. Configuration: boolean shorthands and renames.
5. Events, state and exports.
6. Deepgram defaults and `flux.turnDetector`.
7. Talker and thinker: the timeline, `think`, the thinker run, and `@talkio/ai-sdk`.

Each step updates the Deepgram package, the testkit, the example, the README and the tests together.
