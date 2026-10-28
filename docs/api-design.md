# API Design

Talkio's public API before the first stable release: the principles it follows, and the changes that bring today's API in line with them. Talkio is in alpha, so these are breaking changes made once, without deprecation shims.

## Principles

- **The core is a skeleton for providers.** Providers own how to sense (models, sockets, resampling, vendor thresholds); the core owns what to do (turn-taking, interruptions, playback, history). The core never knows which vendor produced a signal. If a provider package needs a core change to work, the boundary is wrong.
- **Progressive disclosure.** No configuration gives a sensible agent. Each extra need costs one small step, and adding one never means rewriting what was there.
- **Plain values over ceremony.** A function before a provider object, `true` before `{ enabled: true }`, an array before a combinator.
- **One vocabulary.** The words of the domain (user, agent, turn, pause, probability), not of the implementation (commit, decision mode, human/AI). The same idea has the same name everywhere.
- **Types guide; bad configuration fails at creation**, not in the middle of a call.
- **Only what users need is public.** Internal types and helpers are not exported.

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
createAgent({ stt: deepgram.stt(), llm, tts });

// One line per capability
createAgent({ stt: deepgram.stt(), vad: silero(), turnDetector: smartTurn(), llm, tts });

// STT with built-in turn detection
createAgent({ stt: deepgram.flux(), llm, tts });

// Several detectors: the highest end-of-turn probability counts
const flux = deepgram.flux();
createAgent({ stt: flux, turnDetector: [flux.turnDetector, smartTurn()], llm, tts });

// Your own text model, as a function
createAgent({
  stt,
  llm,
  tts,
  turnDetector: ({ transcript, messages, signal }) =>
    myModel.score(transcript, messages, { signal }),
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
  messages: readonly Message[];
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
llm: (ctx) => streamText({ model, messages: ctx.messages, abortSignal: ctx.signal }).textStream;

// Or drive it by hand
llm: async (ctx) => {
  for await (const token of stream) ctx.token(token);
  ctx.complete();
};
```

| Today                                     | Proposed                                        | Why                                                                 |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `LLMFunction` returns `void`              | May return `AsyncIterable<string>` or a promise | Any streaming SDK plugs in with one line; rejections become errors. |
| `complete(fullText)`                      | `complete(text?)`                               | The core already has the tokens.                                    |
| `waitForCommit()`                         | `turnConfirmed()`                               | Says what it waits for.                                             |
| `LLMProvider.generate(messages, ctx)`     | `generate(ctx)`                                 | `ctx.messages` already holds them.                                  |
| `isLLMProvider`, `isLLMFunction` exported | Internal                                        | Only the core needs them.                                           |

### Providers

| Today                                                     | Proposed                                           | Why                                                     |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `createCustomSTTProvider`, `createCustomTTSProvider`, ... | `createSTT`, `createTTS`, `createVAD`, `createLLM` | Shorter, and they read like `createAgent`.              |
| `metadata.type`, `version` on every provider              | Removed                                            | The slot says the type; versions are in `package.json`. |
| `VADProvider.processAudio`, `TurnDetector.onAudio`        | `sendAudio`                                        | One name, as on STT.                                    |
| `VADContext.speechEnd(duration)`                          | `speechEnd()`                                      | The core times speech itself, as it does for STT.       |
| `VADContext.speechProbability(p)`                         | `probability(p)`                                   | Shorter in context.                                     |
| `VADContext` has no audio format                          | `ctx.audioFormat`                                  | A model has to know what it is reading.                 |
| `TTSContext.audioChunk(audio)`                            | `audio(audio)`                                     | Shorter in context.                                     |

### Agent configuration

```ts
createAgent({
  stt,
  llm,
  tts,
  fillers: true,
  backchannels: true,
  silence: { afterMs: 8000, prompt: "Are you still there?" },
  turnTaking: { eagerness: "low" },
  interruption: { minWords: 3 },
  onEvent,
});
```

| Today                                                                            | Proposed                                          | Why                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `fillers: { enabled: true }`, same for `backchannels`, `silence`, `interruption` | `true`, `false`, or options; options mean enabled | Turning a feature on is one word.           |
| `turnTaking.minEndOfTurnDelayMs` / `maxEndOfTurnDelayMs`                         | `minDelayMs` / `maxDelayMs`                       | The section already says what the delay is. |
| `turnTaking.endOfTurnThreshold` / `eagerEndOfTurnThreshold`                      | `threshold` / `eagerThreshold`                    | Same.                                       |
| `interruption.speculativeCutoffMs`                                               | `pauseAfterMs`                                    | Says what happens.                          |
| `interruption.interimMinWords` / `interimMinChars`                               | `minWords` / `minChars`                           | Shorter.                                    |
| `silence.timeoutMs` / `promptMessage`                                            | `afterMs` / `prompt`                              | Matches `fillers.afterMs`.                  |
| `observability: { level: "trace", onTrace }`                                     | `onTrace`                                         | Passing a handler is the switch.            |
| `simulatedClock`                                                                 | `clock`                                           | Not only for simulation.                    |

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

| Today                                   | Proposed     | Why                                                        |
| --------------------------------------- | ------------ | ---------------------------------------------------------- |
| `AgentState.value` (XState state value) | Removed      | Exposes the implementation; `status` says what users need. |
| `AgentState.isRunning` and `status`     | `status`     | One source of truth.                                       |
| `AgentState.partialTranscript`          | `transcript` | It is the latest transcript, final or not.                 |

### Exports

- Removed from the root: `NormalizedAgentConfig`, `Resolved*Config`, `normalizeAudioConfig`, `normalizeFormat`, `ProviderType`, `BaseProvider`, `isLLMProvider`, `isLLMFunction`.
- Audio utilities (`resample`, `mulawToLinear16`, ...) move to `talkio/audio`, which already exists for conversions.

### Deepgram

| Today                                     | Proposed                                        | Why                                                    |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `deepgram.stt({ model })`, model required | `deepgram.stt()` defaults to `nova-3`           | Defaults should work.                                  |
| `deepgram.tts({ model })`, model required | `deepgram.tts()` defaults to `aura-2-thalia-en` | Same.                                                  |
| Flux turn signals only end turns          | Also `flux.turnDetector`                        | Combine Flux with other detectors without a core flag. |

## Not changing

- `createAgent({ stt, llm, tts })`, `agent.start/stop/sendAudio/say/reportPlayback`, `audioStream`, `subscribe`, `getSnapshot`.
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

Each step updates the Deepgram package, the testkit, the example, the README and the tests together.
