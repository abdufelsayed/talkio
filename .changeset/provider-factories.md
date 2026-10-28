---
"talkio": minor
"@talkio/testkit": minor
"@talkio/deepgram": patch
---

Breaking: shorter provider factories and contracts.

- `createCustomSTTProvider`, `createCustomTTSProvider`, `createCustomLLMProvider` and `createCustomVADProvider` are renamed `createSTT`, `createTTS`, `createLLM` and `createVAD`, and their option types `CreateSTTOptions`, `CreateTTSOptions`, `CreateLLMOptions` and `CreateVADOptions`.
- Provider metadata no longer has `type` or `version`, and `ProviderType` is removed.
- VAD providers: `processAudio` is renamed `sendAudio`, and `ctx.speechProbability(p)` is renamed `ctx.probability(p)`. `ctx.speechEnd(durationMs?)` takes an optional duration; without one, the agent times speech from `speechStart`. The context now has `audioFormat`.
- TTS providers: `ctx.audioChunk(audio)` is renamed `ctx.audio(audio)`.
- Testkit: the metadata conformance checks drop `expectedType` and `requireVersion`, the VAD probe accepts an `audioFormat`, and it records speech ends without a duration as `undefined`.
