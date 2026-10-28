---
"talkio": patch
---

Keep the end of a turn that interrupts the agent. When the user talked over the agent, the turn source's signal could be lost if it arrived before the interruption was confirmed. That happened with a custom async classifier, or when a turn detector called `turnEnd("")` before any words were transcribed. In decision mode the agent then never answered; with STT turns it waited 4 seconds and dropped the final words. Speech over the agent is now recorded as it arrives and carried into the user's turn, together with any `turnEnd`.
