---
"talkio": minor
"@talkio/testkit": minor
---

Breaking: one vocabulary for events, a smaller state snapshot, and fewer root exports.

- Events: `human-turn:*` becomes `user-turn:*` and `ai-turn:*` becomes `agent-turn:*`, and their types are renamed to match (`UserTurnEndedEvent`, `AgentTurnInterruptedEvent`, `UserTurnMetrics`, `AgentTurnMetrics`, ...). Trace event types follow the same names.
- `user-turn:ended` reports `text` instead of `transcript`, as `agent-turn:ended` does.
- `agent-turn:interrupted` keeps `generatedText` and `heardText`. `partialText` and `spokenText` duplicated other fields, and `audioStartedText` and `audioCompletedText` are dropped. `agent-turn:interruption-pending` and `agent-turn:interruption-cancelled` report `generatedText` instead of `partialText`.
- `turnId` is required on turn and audio events.
- `AgentState`: `status` is `"idle" | "running" | "stopped"`. `value`, `isRunning` and `output` are removed. `partialTranscript` becomes `transcript`: what the user has said in the current turn, final and interim.
- Audio helpers (`resample`, `float32ToLinear16`, `createAudioDecoder`, `normalizeFormat`, ...) move from the root to `talkio/audio`, which replaces `talkio/audio/conversions`. The root no longer exports `NormalizedAgentConfig`, `NormalizedAudioConfig`, the `Resolved*Config` types, `DEFAULT_AUDIO_*` or `BaseProvider`.
