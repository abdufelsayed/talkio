---
"talkio": minor
"@talkio/testkit": minor
---

Breaking: LLM functions and providers can return a stream of text.

- An `LLMFunction`, or `LLMProvider.generate`, may return an `AsyncIterable<string>` or a promise of one, such as the AI SDK's `textStream`. The agent reports each chunk as a token, completes the generation when the stream ends, reports an error the stream throws, and stops reading it once the generation is aborted. A rejected promise is reported as `agent:error` with source `llm`.
- `LLMProvider.generate(messages, ctx)` becomes `generate(ctx)`; the messages are in `ctx.messages`.
- `ctx.complete(text?)`: the text defaults to the tokens reported so far.
- `ctx.waitForCommit()` is renamed `ctx.turnConfirmed()`.
- `isLLMProvider` and `isLLMFunction` are no longer exported.
- Testkit: the LLM probe records `complete()` without text as `undefined`.
