---
"talkio": minor
"@talkio/testkit": minor
"@talkio/deepgram": patch
---

Breaking: a turn detector is now a function, a plain `TurnDetector` object, or an array of them, and `createCustomTurnDetectorProvider` is removed.

- A function receives each pause (`{ transcript, messages, signal }`) and returns the end-of-turn probability. It is called when the user stops talking and again when the transcript changes during the pause. `signal` aborts when the user resumes or the turn ends, and a result that arrives after that is ignored.
- `TurnDetector` objects implement only what they need: `start`, `stop`, `onPause`, `sendAudio` (was `onAudio`), `onTranscript` and `onSpeechStart`. `onSpeechEnd` and `onContext` are replaced by `onPause`. A promise returned by `start` or `onPause` that rejects, or a hook that throws, is reported as `agent:error` with source `turnDetector` and counted in `metrics.errors.bySource.turnDetector`.
- `metadata.mode: "decision" | "prediction"` becomes `output: "decision" | "probability"`, and the default is now `"probability"`.
- With several detectors, each one's latest probability counts until the user speaks again, and the highest wins. Any of them can end the turn.
- Turn signals are renamed and live under `ctx.turn` for turn detectors as for STT providers: `end(transcript?)`, `eagerEnd(transcript?)`, `resumed()`, `abandoned(reason)` and `probability(p)`. The transcript is optional; the agent uses the one it assembled.
- Testkit: `assertTurnDetectorProviderConformance` becomes `assertTurnDetectorConformance` and accepts functions and arrays. The turn detector probe records `errors` and `probabilities` and builds pauses with `probe.pause(transcript, messages)`. `turnDetectorMode` becomes `turnDetectorOutput`, and the fake turn detector records `receivedPauses`.
