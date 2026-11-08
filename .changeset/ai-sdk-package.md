---
"@talkio/ai-sdk": minor
---

New package: use any AI SDK language model as talkio's talker or thinker with `aiSdk(model, settings?)`. AI SDK `tool()` definitions work as talkio tools as they are. Reasoning and tool-call provider metadata go back to the model, so multi-step tool use works with Anthropic thinking and Gemini 3, and a call the AI SDK marks invalid is answered with its error instead of running the tool.
