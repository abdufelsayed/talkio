---
"talkio": minor
"@talkio/testkit": minor
---

Richer turn detection contract.

- Turn detectors and STT providers share `TurnSignals`: `turnEnd`, `turnAbandoned`, `eagerTurnEnd`, `turnResumed`, and `endOfTurnProbability`.
- Turn detectors declare `metadata.mode`. `"decision"` detectors (the default) call `turnEnd` themselves. `"prediction"` detectors only report end-of-turn probabilities, and the agent ends the turn after a silence that shrinks as confidence grows. Configure it with the new `turnTaking` option (`eagerness: "low" | "medium" | "high"`, `minEndOfTurnDelayMs`, `maxEndOfTurnDelayMs`, `endOfTurnThreshold`).
- Turn detectors can implement `onAudio` (audio-native models) and `onContext` (receives the conversation whenever it changes). The context now includes `audioFormat`.
- STT providers with native turn detection set `metadata.turnDetection` and report through `ctx.turn`; without a separate turn detector, those signals end turns instead of final transcripts.
- Testkit: fakes and probes support the new signals (`emitEndOfTurnProbability`, `stt.turn`, `turnSignals` records), harness options `turnDetectorMode`, `sttTurnDetection`, and `turnTaking`, and trace steps `turn.probability`, `turn.eagerEnd`, `turn.resumed`, and `stt.turnEnd`.
