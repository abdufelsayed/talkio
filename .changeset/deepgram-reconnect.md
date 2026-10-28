---
"@talkio/deepgram": minor
---

`deepgram.stt()` and `deepgram.flux()` reconnect when a connection drops after opening, instead of losing transcription for the rest of the session. They retry with backoff (up to 5 attempts over about 15 seconds), deliver up to about 30 seconds of audio sent during the outage once reconnected, and report an error only when they give up. A connection that never opened is still reported immediately. Flux ends a turn the dropped stream was in with what it had heard. A failed connection now reports one error instead of two.
