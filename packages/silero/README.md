# @talkio/silero

[Silero VAD](https://github.com/snakers4/silero-vad) voice activity detection for [talkio](../talkio), run locally with ONNX Runtime. It tells the agent when someone is speaking, faster and more reliably than an STT's speech events, which shortens barge-in and gives turn detectors precise pauses.

## Installation

```bash
npm install @talkio/silero
```

The Silero v5 model (2.3 MB, MIT) ships with the package. It runs on Node.js and Bun.

## Usage

```typescript
import { createAgent } from "talkio";
import { silero } from "@talkio/silero";

const agent = createAgent({ stt, llm, tts, vad: silero() });
```

With a VAD configured, the agent takes voice activity from it instead of from the STT.

## Options

```typescript
silero({
  threshold: 0.5, // probability at which a frame counts as speech
  minSpeechMs: 64, // shorter sounds, such as clicks and taps, are ignored
  minSilenceMs: 300, // silence that ends speech
  modelPath: "./silero_vad.onnx", // a different Silero v5 model
});
```

Keep `minSilenceMs` short. It decides when a pause starts, and the agent's turn-taking (`turnTaking`, or a turn detector) decides whether the pause ends the user's turn.

Speech starts at `threshold`, and only a probability 0.15 below it counts as silence, so speech that hovers around the threshold does not flicker. Each speech end reports how long the speech lasted, not counting the silence the VAD waited for.

## Audio

Silero reads 16 kHz audio. The provider converts the agent's input format: `linear16`, `float32`, `mulaw` and `alaw`, mono or stereo, at any sample rate. Compressed input (`opus`, `mp3`, ...) is reported as an error.

Every analyzed frame (32 ms) is also reported as a `vad:probability` event, for visualizing voice activity.

## License

Apache-2.0. The bundled model is MIT-licensed by the Silero Team; see [`models/LICENSE`](./models/LICENSE).
