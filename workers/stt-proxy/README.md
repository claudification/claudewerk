# stt-proxy

The speech-to-text edge for the control panel. Browser WebSocket in, Workers AI
speech models out, one normalised transcript shape back.

## Why this exists

Voice dictation streamed from the browser straight to `api.deepgram.com`, which
is a **single US datacenter** (`api-alt.md1`, no anycast, 270ms RTT from
Thailand). Measured 2026-08-13, same audio, same params, same real-time pacing:

| provider | OPEN | LAG first | LAG last | LAG max | verdict |
|---|---|---|---|---|---|
| `api.deepgram.com` direct | 1115ms | 1008ms | **8484ms** | 9678ms | GROWING |
| Workers AI `nova-3` | 1857ms | 138ms | 308ms | 1602ms | FLAT |
| Workers AI `flux` | 1793ms | **91ms** | **74ms** | 195ms | FLAT |

Deepgram-direct collapsed on two of three runs. Cloudflare was flat on all three.
Same models. The only variable was the network path. Re-run it yourself with
`bun run probe:stt` from the repo root.

**The browser cannot call Workers AI directly**: it authenticates with an
`Authorization: Bearer` header, and a browser cannot set headers on a WebSocket.
Hence this Worker. Being forced into it is what buys the token mint going away
(the old Deepgram grant call measured **838-2718ms** in front of every key press)
and the socket opening at the edge instead of the control plane.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /listen?t=<token>&model=<name>&...` | WebSocket upgrade; the audio session |

`t` is a short-lived HMAC token minted by the broker (`POST /api/voice/stt-token`)
and verified with the shared `STT_SIGNING_SECRET`. It authorises one thing --
opening a speech socket -- and is not a session token.

## Wire protocol (browser <-> this Worker)

**Up:** binary frames = audio, exactly as captured. One JSON control message:
`{"type":"stop"}` when the push-to-talk key is released.

**Down:**

```jsonc
{ "type": "transcript", "text": "...", "committed": "...", "final": false,
  "audioEndMs": 5750, "endOfTurnConfidence": 0.12 }
{ "type": "done", "text": "the whole dictation", "reason": "upstream-done" }
{ "type": "error", "error": "..." }
```

**The contract that makes two models interchangeable:** `text` is always the FULL
text of the segment/turn in flight, and `committed` is everything finished before
it. Render `committed + text`. Never append `text` yourself -- flux's transcript
is cumulative, so appending duplicates every word.

## Models

| | `flux` (default) | `nova-3` |
|---|---|---|
| Capture | **raw PCM only** (linear16/16k) | container (webm/opus, mp4) or PCM |
| Wire | `TurnInfo`, cumulative per turn | `Results`, segment deltas |
| End of audio | `CloseStream` only | `Finalize` + `CloseStream` |
| Tunables | `eot_threshold`, `eot_timeout_ms` | `endpointing`, `utterance_end_ms` |
| Price (WS) | $0.0077/audio-min | $0.0092/audio-min |

Hard-won specifics, all verified live rather than read in docs:

- **flux is raw-PCM-only on Workers AI.** Fed a webm/opus container with
  `encoding` omitted it accepts every byte, errors on nothing, and returns **no
  transcript at all** -- a silent no-op. Deepgram's own Flux docs claim container
  support; the Workers AI build does not have it. nova-3 *does* auto-detect
  containers.
- **flux rejects `Finalize`** (`UNPARSABLE_CLIENT_MESSAGE ... expected CloseStream
  or Configure`) and closes 1011.
- **flux requires params.** With no query params at all the WS upgrade is
  rejected 1002 before a byte flows; `sample_rate` is the one it needs.
- Raw PCM into flux is safe despite the July regression that raw PCM caused with
  the v1 pipeline: 197 seconds of CONTINUOUS dictation with a real mic noise floor
  (never true silence -- the exact condition that broke v1's RMS endpointer) held
  **LAG 91 -> 118ms, max 315ms, FLAT**. flux's turn detection is a conversational
  model, not a silence threshold.

## Push-to-talk is the contract

The user's key hold defines the utterance. A flux `EndOfTurn` is a **paragraph
break**, never a submit -- long dictation is a deliberate use case here, and a
model deciding the speaker is finished mid-thought is worse than no voice input.
Only the client's `stop` ends a session.

## Deploy

```bash
cd workers/stt-proxy
bunx wrangler secret put STT_SIGNING_SECRET  # must match the broker's
bunx wrangler deploy
bunx wrangler tail stt-proxy --format pretty
```

**One secret, and no account token at all.** The speech models are reached through
the `AI` binding, which the deployment itself authorises -- so this Worker holds no
Cloudflare credential and makes no egress call. A credential that does not exist
cannot leak. `STT_SIGNING_SECRET` only lets it check that the broker signed a
token; it grants nothing on its own.

Deploying this Worker does not touch the broker and drops no WebSockets.
