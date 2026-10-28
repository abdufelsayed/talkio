---
"talkio": minor
"@talkio/testkit": minor
---

Track what the listener has heard.

- `ai-turn:ended` now fires when the turn's audio has finished playing, not when synthesis finished. The agent counts audio as played in real time from release, stalls the estimate when the listener's buffer runs dry, and freezes it while paused. User speech during the last seconds of playback is therefore handled as an interruption instead of starting a new turn over the agent's voice.
- `ai-turn:interrupted` reports `heardText`, cut at the last word the user heard, and the conversation history keeps that text. TTS providers can report `ctx.wordTimings()` for exact cuts; otherwise the agent estimates from an even speech rate.
- `agent.reportPlayback({ turnId, playedMs })` lets clients report their real playback position, and `playback.outputLatencyMs` accounts for transport and jitter-buffer delay.
- With `interruption.pendingAudio: "clear"`, a cancelled interruption replays the audio the listener dropped, from where they stopped hearing it.
- Compressed output formats, whose duration cannot be derived from their size, keep ending the turn when synthesis finishes.

Testkit: `FakeTTS.emitWordTimings()` and `TTSContextProbe.wordTimings`.
