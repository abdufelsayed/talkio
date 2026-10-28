---
"@talkio/smart-turn": minor
---

New package: Smart Turn v3 audio end-of-turn detection, run locally with ONNX Runtime. `turnDetector: smartTurn()` scores each pause from the last eight seconds of the user's audio (intonation, pace, trailing filler sounds) in 23 languages, in about 40 ms, with the bundled Smart Turn v3.2 model. Its Whisper log-mel features are computed in TypeScript.
