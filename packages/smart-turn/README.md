# @talkio/smart-turn

[Smart Turn v3](https://github.com/pipecat-ai/smart-turn), an audio end-of-turn model by Daily, as a [talkio](../talkio) turn detector. It listens to how the user stopped (intonation, pace, a trailing "um") to tell a finished sentence from a thinking pause, in 23 languages, and runs locally with ONNX Runtime in about 40 ms.

## Installation

```bash
npm install @talkio/smart-turn @talkio/silero
```

The Smart Turn v3.2 model (8.7 MB, int8, BSD-2-Clause) ships with the package. It runs on Node.js and Bun.

## Usage

```typescript
import { createAgent } from "talkio";
import { silero } from "@talkio/silero";
import { smartTurn } from "@talkio/smart-turn";

const agent = createAgent({
  stt,
  llm,
  tts,
  vad: silero({ minSilenceMs: 200 }),
  turnDetector: smartTurn(),
});
```

Each time the user pauses, Smart Turn scores the last eight seconds of their audio. The agent answers after `turnTaking.minDelayMs` when the user sounds done, and waits up to `maxDelayMs` when they sound mid-thought. A VAD gives it prompt, precise pauses; a short `minSilenceMs` lets it score as soon as the user stops.

Smart Turn hears audio but not words. To also weigh what was said, combine it with a text model. The highest probability counts:

```typescript
turnDetector: [smartTurn(), ({ transcript, messages }) => textModel.score(transcript, messages)],
```

## Options

```typescript
smartTurn({
  modelPath: "./smart-turn-v3.2-cpu.onnx", // a different Smart Turn v3 model
});
```

## Audio

Smart Turn reads 16 kHz audio. The detector converts the agent's input format: `linear16`, `float32`, `mulaw` and `alaw`, mono or stereo, at any sample rate.

## License

Apache-2.0. The bundled model is BSD-2-Clause licensed by Daily; see [`models/LICENSE`](./models/LICENSE).
