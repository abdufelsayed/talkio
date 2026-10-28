---
"talkio": minor
---

Configured filler and backchannel phrases are synthesized once and their audio is replayed after that. A backchannel used to start synthesizing only after the user's pause, so it often played after the user had started their next sentence; replayed phrases play right away and leave the TTS session free. Text the LLM passes to `ctx.say()` varies, so it is still synthesized every time. Replays appear in traces as `phrase:replayed`.
