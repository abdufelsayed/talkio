---
"talkio": patch
---

With a turn detector or an STT provider that detects turns natively, an interruption reported as both a final transcript and a turn end no longer starts two user turns. A final transcript now only confirms the interruption; the turn source still decides when the user's turn ends.
