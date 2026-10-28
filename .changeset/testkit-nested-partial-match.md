---
"@talkio/testkit": patch
---

`expectEvent`, `expectTrace` and `assertPartialMatch` now match nested objects partially and arrays element by element. They compared nested values by identity, so any expectation such as `{ data: { text: "…" } }` always failed.
