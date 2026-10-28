---
"@talkio/deepgram": minor
"talkio": patch
---

`deepgram.stt()` defaults to `nova-3` and `deepgram.tts()` to `aura-2-thalia-en`, so `model` is optional.

`deepgram.flux()` exposes its turn signals as `flux.turnDetector`, so Flux can be combined with other turn detectors: `turnDetector: [flux.turnDetector, smartTurn]`. The highest end-of-turn probability counts, and Flux's `EndOfTurn` still ends the turn.

When the agent ends a user turn on interim words, the STT still owes their final transcript. A final transcript or turn end that only restates that turn within 5 seconds no longer starts a second user turn; it is traced as `transcript:restated`. Before, Flux's `EndOfTurn` arriving after another detector had ended the turn made the agent answer twice.
