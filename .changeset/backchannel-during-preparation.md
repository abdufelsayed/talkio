---
"talkio": patch
---

The agent can now backchannel while it prepares a reply speculatively, as long as the phrase it would say has already been recorded. Replaying it doesn't use the TTS session the prepared reply may be using. It still never backchannels over a reply the user can hear.
