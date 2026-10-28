---
"talkio": patch
---

Fix mu-law conversion. `mulawToLinear16` and `linear16ToMulaw` used 14-bit G.711 constants on 16-bit samples: decoded audio came out at the wrong level, and every sample above about 8000 encoded to the same byte, clipping loud telephony audio. Both now follow G.711 for 16-bit samples. This affects mu-law input the agent decodes, such as telephony audio sent to a provider that needs PCM.
