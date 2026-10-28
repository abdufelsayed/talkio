---
"talkio": minor
"@talkio/testkit": minor
---

Breaking: shorter agent configuration.

- `fillers`, `backchannels`, `silence` and `interruption` accept `true`, `false` or options. Options turn a feature on, so the `enabled` field is removed: write `fillers: true` or `fillers: { afterMs: 800 }`, and `interruption: false` instead of `{ enabled: false }`.
- `turnTaking`: `minEndOfTurnDelayMs`, `maxEndOfTurnDelayMs`, `endOfTurnThreshold` and `eagerEndOfTurnThreshold` become `minDelayMs`, `maxDelayMs`, `threshold` and `eagerThreshold`.
- `interruption`: `speculativeCutoffMs`, `interimMinWords` and `interimMinChars` become `pauseAfterMs`, `minWords` and `minChars`.
- `silence`: `timeoutMs` and `promptMessage` become `afterMs` and `prompt`.
- `observability: { level: "trace", onTrace }` becomes `onTrace`, and `ObservabilityConfig` is removed.
- `simulatedClock` becomes `clock`.
- Testkit: harness options accept the same shorthands.
