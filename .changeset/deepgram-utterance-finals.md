---
"@talkio/deepgram": patch
---

Report one final transcript per utterance instead of one per finalized segment. Deepgram's `is_final` only means a segment's text is settled; the provider now merges segments and reports `isFinal` on `speech_final` or `UtteranceEnd`, so a mid-sentence segment boundary no longer ends the user's turn. Defaults now match the documented values (`endpointing: 300`, `utteranceEndMs: 1000`), and `utterance_end_ms` is only sent when interim results are enabled.
