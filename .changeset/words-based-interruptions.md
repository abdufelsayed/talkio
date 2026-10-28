---
"talkio": minor
"@talkio/testkit": minor
---

Confirm interruptions by what the user says, not by how long they make a sound.

The agent still yields the moment it detects user speech, but an interruption is only confirmed by words: an interruption cue ("stop", "wait", "actually"), enough words in an interim transcript (`interimMinWords`), or a final transcript. Acknowledgements ("mm-hmm", "yeah", "got it") resume the agent with reason `backchannel` however long they last. Transcripts that repeat what the agent is saying resume it with reason `echo`, and for the rest of that turn voice alone no longer pauses it. Speech that produces no words resumes after `resumeAfterMs` (default 600), or after `maxPendingMs` (default 3000) of continuous sound, with reason `no-transcript`. Speech shorter than `minDurationMs` is still a `false-start`, and `minDurationMs: 0` keeps interrupting on any speech.

Plug in your own `interruption.classifier`, including an async, model-based one, or reuse the exported `classifyInterruption`.

Testkit: the human simulation now covers realistic backchannels (250–700ms, transcribed), wordless noise, and echo, scores overlaps cancelled for the wrong reason (`misclassifiedOverlaps`), and its barge-ins produce words. `maxBargeInLatencyMs` measures time to the confirmed interruption and defaults to 450ms.
