# @talkio/testkit

Testing utilities and simulators for Talkio voice agents.

## Scenario API

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

The package is intentionally runner-agnostic. Its assertions throw ordinary errors, so it can be used from Vitest, Jest, the Node test runner, or custom stress scripts.

## Property Tests

```typescript
import {
  aiTurnLifecycleTraceArbitrary,
  assertTraceInvariants,
  runTrace,
  scenarioTraceArbitrary,
} from "@talkio/testkit";
import { test } from "@fast-check/vitest";

test.prop([scenarioTraceArbitrary({ minTurns: 1, maxTurns: 3 })])(
  "generated traces satisfy public event invariants",
  async (trace) => {
    const result = await runTrace(trace);
    result.events.assertInvariants();
    assertTraceInvariants(result.traces);
  },
);

test.prop([aiTurnLifecycleTraceArbitrary({ minTurns: 1, maxTurns: 3 })])(
  "generated lifecycle traces satisfy streaming invariants",
  async (trace) => {
    await runTrace(trace);
  },
);
```

## Trace and Latency Assertions

```typescript
import {
  assertTraceInvariants,
  assertTraceLatencyBudgets,
  collectTraceLatencies,
  createScenario,
} from "@talkio/testkit";

const result = await createScenario()
  .start()
  .sttFinal("hello")
  .expectEvent("ai-turn:started")
  .llmSentence("Hi.", 0)
  .ttsChunk()
  .llmComplete("Hi.")
  .ttsComplete()
  .expectEvent("ai-turn:ended")
  .run();

assertTraceInvariants(result.traces);
assertTraceLatencyBudgets(result.traces, {
  maxTimeToFirstAudioFromTurnStartMs: 500,
  maxInterruptionConfirmMs: 250,
  maxAudioDrops: 0,
});

console.log(collectTraceLatencies(result.traces));
```

## Provider Conformance

```typescript
import {
  assertNoSTTEventsAfterAbort,
  assertSTTProviderConformance,
  createSTTContextProbe,
} from "@talkio/testkit";

assertSTTProviderConformance(sttProvider, { expectedName: "Deepgram" });

const probe = createSTTContextProbe();
sttProvider.start(probe.context);
await assertNoSTTEventsAfterAbort(probe, async () => {
  await flushProviderCallbacks();
});
```

The conformance helpers validate offline provider contracts: metadata, supported formats,
defaults, required provider methods, post-abort silence, event mapping, and cleanup behavior.
Context probes and `installMockWebSocket()` can be used without live credentials.

## Regression Fixtures

```typescript
import { REGRESSION_TRACE_FIXTURES, runTrace } from "@talkio/testkit";

for (const fixture of REGRESSION_TRACE_FIXTURES) {
  await runTrace(fixture.trace, fixture.options);
}
```

The fixtures cover the high-risk voice-agent cases that should stay deterministic:
LLM completion before TTS drain, interruption after LLM completion, and cancelled
backchannels.

## Stress Runs

```bash
bun run test:stress --runs 1000 --lifecycle-runs 1000 --human-runs 1000 --seed 123 --turns 4
```

When a generated trace fails, the runner prints the seed and replayable trace shape.

## XState Graph

The package re-exports selected `@xstate/graph` helpers including `getShortestPaths`, `getSimplePaths`, `getPathsFromEvents`, and `createTestModel` for machine-level coverage.
