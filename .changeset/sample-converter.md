---
"talkio": minor
---

`talkio/audio` exports `createSampleConverter(format, sampleRate)`, which turns a stream of input chunks (`linear16`, `float32`, `mulaw` or `alaw`, mono or stereo) into mono float samples at a given rate, keeping samples split across chunks. Model-based providers such as VADs and turn detectors use it to read the agent's input audio.
