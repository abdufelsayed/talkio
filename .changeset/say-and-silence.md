---
"talkio": minor
"@talkio/testkit": minor
---

Speak without the LLM, and prompt users who go quiet.

- `agent.say(text)` speaks fixed text, such as a greeting, as an AI turn without calling the LLM. It waits until neither the agent nor the user is mid-turn and is recorded as an assistant message.
- The `silence` config now works (it was documented but never implemented). After `timeoutMs` with neither side speaking, the agent emits `silence:detected` and speaks `promptMessage`, up to `maxPrompts` times until the user speaks again. With the default `startMode: "afterFirstSpeech"`, it only starts watching once the user has spoken.

Testkit: the event invariants allow agent-initiated AI turns and instead reject AI turns that start while a human turn is open; the trace invariants accept scripted turns without an LLM call.
