---
"talkio": patch
---

The agent no longer reacts to its own voice in two cases. With `interruption.minDurationMs: 0`, voice activity stops interrupting once the agent has recognized its own echo; words still interrupt. With interruptions disabled, a "user turn" that only repeats what the agent is saying is abandoned with reason `echo` instead of being queued and answered. The `pendingAudio: "clear"` docs now note that replaying discarded audio needs PCM or telephony output.
