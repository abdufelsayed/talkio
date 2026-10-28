---
"@talkio/deepgram": patch
---

- `deepgram.stt()` with both `endpointing: false` and `interimResults: false` now reports each finalized segment as a final transcript. Deepgram signals no utterance ends in that configuration, so segments used to pile up and repeat in every later turn.
- `deepgram.stt()` and `deepgram.flux()` only buffer audio while the socket is connecting. After a connection closed or failed, audio kept accumulating in memory for the rest of the session, and a later `start()` sent it into the new connection.
