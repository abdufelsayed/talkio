---
"talkio": minor
"@talkio/testkit": minor
---

Add thinking fillers and agent backchannels. Both are off by default.

- `fillers`: when a reply has been silent for `afterMs` (default 1200), for example while the LLM calls tools, the agent says a short phrase such as "One moment." Fillers rotate through `phrases`, are never part of the reply text, history or `heardText`, and wait again if the user talks during the pause.
- `backchannels`: while the user talks at length, the agent says "mm-hmm" in pauses that are probably mid-thought. That means after `minSpeechMs` (default 4000) of speech, a `pauseMs` (default 400) pause, and an end-of-turn probability of at most `maxEndOfTurnProbability` (default 0.3). It needs end-of-turn probabilities from a turn detector or an STT provider with native turn detection. The new `agent:backchannel` event announces each one; its audio arrives as `ai-turn:audio` with the backchannel's `turnId`. A reply that starts meanwhile waits for the backchannel to finish, and a backchannel that fails to synthesize emits `agent:error` with source `tts`.

Testkit: harness options `fillers` and `backchannels`; `FakeTTS.requestedTexts` records every text the agent asked to synthesize. The event invariants only treat audio of the interrupted turn as stale, and the trace invariants check backchannel and filler traces and keep backchannels out of turn latencies.
