---
"talkio": minor
"@talkio/testkit": patch
---

Rebuild turn orchestration around explicit human and AI turn states.

- Pending interruptions pause the agent instead of destroying its audio. The new `audio:pause` and `audio:resume` events let clients pause playback, audio produced while paused is held, and a cancelled interruption continues exactly where it stopped. Sentences generated while an interruption is pending are no longer dropped. Set `interruption.pendingAudio: "clear"` for transports that can only flush their buffer.
- `ai-turn:interruption-cancelled` reports a `reason` (`"false-start"` or `"backchannel"`), and final transcripts that only acknowledge the agent ("yeah", "mm-hmm") no longer interrupt it.
- The agent no longer starts talking over a user who began speaking before its first audio.
- With `interruption.enabled: false`, user turns spoken during a response are answered afterwards instead of being dropped.
- Consecutive user turns are merged into one message when the agent said nothing audible in between.
- Empty final transcripts are ignored instead of starting an LLM turn with an empty message.
- `audioStream` is pull-based: slow readers no longer lose chunks, and unread audio of an interrupted turn is discarded so relays never forward stale audio.
- History trimming preserves system messages, `totalAudioSamples` counts samples instead of bytes, and latency metrics are correct when the clock starts at zero.
- STT-reported voice activity ends on a final transcript or after two seconds without one, so unpaired speech-start events cannot block later barge-ins.
