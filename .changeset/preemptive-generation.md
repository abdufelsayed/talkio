---
"talkio": minor
"@talkio/testkit": minor
---

Preemptive generation. On an eager end-of-turn signal (`eagerTurnEnd` from a turn detector or an STT provider with native turn detection, or a prediction-mode probability above `turnTaking.eagerEndOfTurnThreshold`), the agent starts generating and synthesizing its reply before the turn is confirmed. Nothing is audible or public until `turnEnd` confirms the same transcript: then the buffered events replay and held audio plays immediately without regenerating. If the user keeps talking, or the confirmed transcript differs, the prepared reply is discarded. LLM providers get `ctx.isSpeculative()` and `ctx.waitForCommit()` so side effects can wait for the turn to commit. Disable with `turnTaking.preemptiveGeneration: false`.

Testkit: `FakeLLM.generations` counts started generations, the LLM context probe accepts `speculative` and `commitment`, and latency budgets measure adopted speculative turns from their commit.
