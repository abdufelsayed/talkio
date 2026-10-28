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

`createScenario(options)` drives an agent wired to fake providers on a simulated clock. Options choose what to test against:

| Option                            | Effect                                                    |
| --------------------------------- | --------------------------------------------------------- |
| `useVAD`, `useTurnDetector`       | Add a fake VAD or turn detector                           |
| `turnDetectorOutput`              | `"probability"` (default) or `"decision"`                 |
| `sttTurnDetection`                | Make the fake STT report turns itself, like Deepgram Flux |
| `turnTaking`, `interruption`      | Passed to `createAgent`                                   |
| `fillers`, `backchannels`         | Passed to `createAgent`                                   |
| `timeout`, `audio`, `maxMessages` | Passed to `createAgent`                                   |

The result exposes the fakes, so you can check what reached them, for example `result.tts.requestedTexts` for everything the agent asked to say.

## Turn Detection Scenarios

```typescript
await createScenario({ useVAD: true, useTurnDetector: true })
  .start()
  .vadSpeechStart()
  .sttFinal("my number is five five five")
  .vadSpeechEnd(800)
  .turnProbability(0.1) // probably mid-thought: the agent keeps listening
  .advance(1000)
  .expectNoEvent("human-turn:ended")
  .turnProbability(0.9)
  .expectEvent("human-turn:ended")
  .run();
```

`turnEagerEnd(transcript)` and `turnResumed()` exercise preemptive generation, `turnEnd()` and `turnAbandoned(reason)` drive a detector with `"decision"` output, and `sttTurnEnd()` drives an STT with native turn detection.

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

Turn detectors are checked the same way. `probe.pause()` builds the pause to score:

```typescript
assertTurnDetectorConformance(smartTurn, { expectedName: "SmartTurn" });

const probe = createTurnDetectorContextProbe();
await smartTurn.start?.(probe.context);
const probability = await smartTurn.onPause?.(probe.pause("thanks, that's all"));
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
LLM completion before TTS drain, interruption after LLM completion, a backchannel
that cancels a pending interruption, and speculative replies that are adopted or
discarded.

## Human Simulation

```typescript
import { assertHumanSimulationPass, runHumanSimulation } from "@talkio/testkit";

const score = await runHumanSimulation({ runs: 200, seed: 123 });
assertHumanSimulationPass(score); // or pass your own thresholds
```

The simulation plays seeded conversations in which a simulated user finishes turns, barges in, starts and stops, backchannels, makes noise, and echoes the agent. It scores false and missed interruptions, misclassified overlaps, stale audio, end-of-turn and barge-in latency, and time to first audio against `DEFAULT_HUMAN_SIMULATION_THRESHOLDS`.

## Stress Runs

```bash
bun run test:stress --runs 1000 --lifecycle-runs 1000 --human-runs 1000 --seed 123 --turns 4
```

When a generated trace fails, the runner prints the seed and replayable trace shape.

## XState Graph

The package re-exports selected `@xstate/graph` helpers including `getShortestPaths`, `getSimplePaths`, `getPathsFromEvents`, and `createTestModel` for machine-level coverage.
