---
"@talkio/deepgram": minor
---

`deepgram.stt()` gains a `keyterms` option for Nova-3, sent as Deepgram's `keyterm` parameters (up to 100). Nova-3 rejects the older `keywords` parameter, which made the connection fail; `keywords` with a Nova-3 model, or `keyterms` with an older one, now throws a clear error when the provider is created.
