---
"talkio": patch
---

The agent ignores its own voice picked up by a microphone without echo cancellation. For about 1.5 seconds after a backchannel or a reply has played, a transcript that only repeats it (at least four of a reply's words in order, so short answers that reuse its words still count) is dropped: it no longer joins the user's words, starts a user turn the agent answers, or reaches the turn detector. A turn a turn detector ends on the agent's words is abandoned with reason `echo`. A one-word backchannel such as "Okay." only matches as the whole transcript.
