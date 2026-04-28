# Talkio Testkit Design

`@talkio/testkit` is the shared simulator and conformance layer for Talkio. It should be useful inside this monorepo and as a public package for users building voice agents on top of Talkio.

## Goals

- Test voice-agent orchestration as deterministic event traces before involving real audio or live providers.
- Let users write readable chained scenarios for common cases.
- Keep every scenario serializable as a plain trace so failures can be replayed and minimized.
- Support assertions over public events and stable agent snapshots.
- Provide provider conformance helpers so adapter packages can prove they map vendor behavior into Talkio correctly.
- Split fast CI tests from longer stress/fuzz runs.

## Non-Goals

- Do not make real provider quality deterministic. Live STT, TTS, network latency, and human speech remain probabilistic.
- Do not expose the XState machine shape as the primary testing contract.
- Do not put raw audio bytes into default traces.

## Package Shape

The package should expose:

- fake STT, LLM, TTS, VAD, and turn detector providers
- event capture and invariant assertions
- a reusable agent harness
- a chained scenario API
- a JSON trace runner
- `fast-check` arbitraries for generated traces
- `@xstate/graph` helpers for state-machine path coverage
- provider conformance helpers
- audio fixture helpers
- fuzz/stress helpers

Initial usage:

```typescript
import { createScenario } from "@talkio/testkit";

await createScenario()
  .start()
  .sttPartial("hello")
  .sttFinal("hello")
  .expectEvent("human-turn:ended", { transcript: "hello" })
  .llmSentence("Hi there.", 0)
  .ttsChunk()
  .llmComplete("Hi there.")
  .ttsComplete()
  .expectEvent("ai-turn:ended", { wasSpoken: true })
  .assertInvariants()
  .run();
```

## Trace Format

Every chained scenario should compile down to a serializable trace:

```typescript
[
  { type: "start" },
  { type: "stt.partial", text: "hello" },
  { type: "stt.final", text: "hello" },
  { type: "expect.event", event: "human-turn:ended", partial: { transcript: "hello" } },
  { type: "llm.sentence", text: "Hi there.", index: 0 },
  { type: "tts.chunk", value: 1, size: 4 },
  { type: "llm.complete", text: "Hi there." },
  { type: "tts.complete" },
  { type: "assert.invariants" },
];
```

Default traces should use semantic events and compact synthetic audio descriptors. Raw audio should be opt-in through fixture references.

## Test Tiers

Fast tests should run under the normal `test` command:

- exact scenario tests
- event ordering assertions
- snapshot assertions
- audio conversion fixture tests
- offline provider conformance tests

Stress tests should run under a longer command:

- model-based randomized traces
- race-condition interleavings
- long-running conversation simulations
- replay of previously minimized failure traces

Normal CI can run a small fixed-seed fuzz sample later, but the long stress suite should be nightly or manual.

## Fuzzing Model

Fuzzing should be powered by `fast-check`. The testkit should export shrinkable arbitraries for valid-ish voice-agent traces, not arbitrary impossible events. The generator should know rough phases:

- agent lifecycle
- human speech and transcription
- turn detection
- LLM generation
- TTS streaming
- interruption
- error and timeout injection
- stop/cleanup

Core invariants:

- internal `_events` are never exposed publicly
- `agent:started` occurs before turn events
- `agent:stopped` is final when present
- each AI turn has an end, interruption, error, or stop boundary
- stale TTS chunks after interruption do not become public audio
- `isSpeaking` eventually clears after completion, interruption, error, or stop
- aborted providers do not produce accepted events
- abandoned turns do not add user messages

Example property test:

```typescript
import { fc, test } from "@fast-check/vitest";
import { runTrace, scenarioTraceArbitrary } from "@talkio/testkit";

test.prop([scenarioTraceArbitrary({ minTurns: 1, maxTurns: 5 })])(
  "generated traces satisfy public event invariants",
  async (trace) => {
    const result = await runTrace(trace);
    result.events.assertInvariants();
  },
);
```

## XState Graph Coverage

`@xstate/graph` should complement generated traces by covering machine topology:

- shortest paths for smoke coverage
- simple paths for deeper transition coverage
- path-from-events replay for reduced traces

The graph layer is not the public behavioral contract for Talkio users. It is a stronger internal coverage tool for machine-level tests and for advanced users who expose their own XState machines.

## Provider Conformance

Provider conformance should be split into two layers:

- Offline conformance: metadata, supported formats, abort behavior, event mapping, and no accepted post-stop emissions.
- Live smoke tests: optional API-key-gated tests for real provider connectivity and broad compatibility.

Adapter packages should depend on `@talkio/testkit` as a dev dependency and run the offline conformance suite in CI.

## Audio Scope

Audio correctness should be tested separately from orchestration fuzzing:

- byte-level input normalization
- fixture-based format tests
- provider format contract tests
- optional live acoustic smoke tests

Raw audio should not be embedded in default failure traces because it is large, hard to diff, and may contain private user data.

## Migration Plan

Done:

1. Move fake provider, event capture, harness, and clock patterns into `@talkio/testkit`.
2. Port public agent behavior tests to the testkit scenario and harness APIs.
3. Add JSON trace replay.
4. Add shrinkable `fast-check` trace generation.
5. Add graph coverage helper exports for XState machines.
6. Delete the duplicated package-local agent harness, clock, event capture, and behavior tests after parity.

Still recommended:

1. Add provider conformance helpers.
2. Expand generated trace coverage for timeout, turn-detector, VAD, and interruption interleavings.
3. Add nightly CI for `bun run test:stress --runs 1000 --seed <fixed-seed> --turns 4`.
4. Keep `packages/talkio/test` focused on internals that cannot live in public testkit tests.
