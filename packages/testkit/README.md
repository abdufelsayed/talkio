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
import { test } from "@fast-check/vitest";
import { runTrace, scenarioTraceArbitrary } from "@talkio/testkit";

test.prop([scenarioTraceArbitrary({ minTurns: 1, maxTurns: 3 })])(
  "generated traces satisfy public event invariants",
  async (trace) => {
    const result = await runTrace(trace);
    result.events.assertInvariants();
  },
);
```

## Stress Runs

```bash
bun run test:stress --runs 1000 --seed 123 --turns 4
```

When a generated trace fails, the runner prints the seed and minimized replayable trace shape.

## XState Graph

The package re-exports selected `@xstate/graph` helpers including `getShortestPaths`, `getSimplePaths`, `getPathsFromEvents`, and `createTestModel` for machine-level coverage.
