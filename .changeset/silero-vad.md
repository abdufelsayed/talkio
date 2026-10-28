---
"@talkio/silero": minor
---

New package: Silero voice activity detection, run locally with ONNX Runtime. `vad: silero()` gives the agent speech starts and ends from the bundled Silero v5 model, with hysteresis against flicker, a minimum speech length against clicks, and speech durations that exclude the silence it waited for. It reads `linear16`, `float32`, `mulaw` and `alaw` input at any sample rate and reports each frame's probability as `vad:probability`.
