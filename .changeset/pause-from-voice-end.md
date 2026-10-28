---
"talkio": patch
---

Count the user's pause from when their voice ended. A final transcript arriving during the pause restarted the end-of-turn countdown, so every reply waited for the STT's finalization latency on top of the turn-taking delay. Transcripts now move the pause start only when no voice end was reported for the current turn. On 300 real recordings with Silero and Smart Turn, replies to finished turns came 200 ms sooner.
