---
"talkio": patch
"@talkio/testkit": patch
---

Turn detectors now receive speech events from whichever source is active. Without a VAD provider, `onSpeechEnd` was never called because STT speech-end events were dropped. Turn detectors can also implement the new optional `onSpeechStart` to cancel a pending end-of-turn decision when the user resumes talking. `FakeTurnDetector` records `receivedSpeechStarts`.
