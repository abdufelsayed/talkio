---
"@talkio/deepgram": minor
---

Add `createDeepgramFlux` and `deepgram.flux()`, a Deepgram Flux (`/v2/listen`) provider with native turn detection. Flux turn events end the user's turn without a separate turn detector: `StartOfTurn` drives barge-in, `EagerEndOfTurn` and `TurnResumed` drive preemptive generation (set `eagerEotThreshold`), and `EndOfTurn` reports the final transcript. Settings Deepgram would reject (out-of-range thresholds, an eager threshold above `eotThreshold`, language hints without `flux-general-multi`) throw when the provider is created.
