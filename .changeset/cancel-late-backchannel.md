---
"talkio": patch
---

A backchannel that hasn't started playing when the user resumes talking is now dropped, instead of being said over their next sentence. Its TTS request is cleared, and it is traced as `backchannel:cancelled`. A backchannel that is already playing finishes.
