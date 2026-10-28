---
"talkio": minor
---

Split LLM output into sentences automatically. LLM providers no longer have to call `ctx.sentence()`: streamed tokens are split into speakable sentences (abbreviations, initials, decimals, and list numbers are kept intact, and long sentences are split at clause breaks for faster first audio), and a provider that only calls `ctx.complete(text)` is spoken too. Providers that call `ctx.sentence()` take over splitting, and text the agent already spoke is not repeated.
