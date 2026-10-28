---
"@talkio/deepgram": patch
---

`deepgram.stt()` sends Deepgram's KeepAlive message once no audio has gone out for 4 seconds. Deepgram closes a stream after 10 idle seconds, so a client that stopped sending audio (push-to-talk, muting, skipping silence) used to lose transcription for the rest of the session. `deepgram.flux()` doesn't send KeepAlive, because Deepgram documents it only for `/v1/listen`.
