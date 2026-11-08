# @talkio/ai-sdk

Use any [AI SDK](https://ai-sdk.dev) language model as talkio's talker or thinker.

## Installation

```bash
npm install @talkio/ai-sdk ai talkio
```

## Usage

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { aiSdk } from "@talkio/ai-sdk";
import { tool } from "ai";
import { createAgent } from "talkio";
import { z } from "zod";

const agent = createAgent({
  stt,
  tts,
  talker: aiSdk(anthropic("claude-haiku-5-5")),
  thinker: aiSdk(anthropic("claude-opus-5-5")),
  instructions: "You are Ava, the receptionist at Acme Dental.",
  tools: {
    findAppointment: tool({
      description: "Find the caller's next appointment",
      inputSchema: z.object({ phone: z.string() }),
      execute: ({ phone }) => appointments.next(phone),
    }),
  },
});
```

AI SDK `tool()` definitions go straight into `tools`: Zod, Standard Schema, and `jsonSchema()` inputs all work.

## How it works

`aiSdk(model, settings?)` returns a talkio model. Each call is one model step: it streams the model's text as tokens and reports the tools the model calls without running them. talkio runs the tools, adds their results to the conversation, and calls the model again.

The model's reasoning and each call's provider metadata go back to it with its tool calls, which Anthropic models with thinking on and Gemini 3 require. A call whose input does not parse or match the tool's schema is answered with the error, and the tool does not run.

`settings` are passed to every `streamText` call: `temperature`, `topP`, `maxOutputTokens`, `maxRetries`, `headers`, and `providerOptions`.

## License

Apache-2.0
