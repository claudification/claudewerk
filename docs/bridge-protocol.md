# Bridge Protocol v1

**Status: DRAFT rev 3 -- 2026-07-08. Design locked (11 decisions, workshop with Jonas);
nothing implemented yet.** Rev 1 bound A2A directly onto the connection -- one layer
too low. Rev 2 = the three-layer, named-object model. Rev 3 adds the normative
envelope/body split (fabric alignment), futility/bounce semantics, and encoding
negotiation (JSON baseline / CBOR upgrade).

Service-to-service bridge between CLAUDEWERK (the broker at `concentrator.frst.dev`)
and remote peer systems. First peer: **GATE**. Either side addresses named things on
the other side and receives asynchronous replies; reach is granted per direction via
independently revocable API keys.

## 1. The model

```
L3  SERVICES      a2a@1 (message passing over sessions) | state@1 (Yjs, seam)
L2  NAMED OBJECTS queues, sessions, state objects -- durable, on BOTH sides,
                  ordered op streams, QoS-1, bulk transfer class
L1  CONNECTIONS   0..N ephemeral authenticated WSS carriers, interchangeable
```

The consolidation points are **named, durable coordination objects** existing on both
sides. Connections are IP-and-transport things: they carry ops, they die, nothing
above notices. With zero connections everything queues; with several, they all feed
the same named objects.

| Object kind | Semantics | Its op stream carries |
|---|---|---|
| **queue** | consume-once mailbox / named receiver | messages |
| **session** | long-lived context between two named endpoints; **outlives connections**, dies only by explicit `close` | lifecycle ops + data primitives |
| **state** | CRDT-backed shared object, both sides mutate, converges (spec seam, v1.1) | Yjs updates |

The substrate unifies **addressing + durable ordered op streams + dedupe**; each
kind's semantics live above it. Prior art shape: SSH connection protocol (RFC 4254) --
authenticated pipe, typed channels, multiplexed -- with the queue layer promoted to
the durable anchor.

**Envelope/body principle (normative):** every message is `envelope + optional
body`. Routing, ordering, dedupe, queueing, and admission read the ENVELOPE ONLY;
the body is an opaque payload interpreted solely by the terminal receiver (the L3
service handler). This is the fabric posture (see prior art: the execution-fabric
whitepaper): it keeps the substrate payload-blind, lets bodies be end-to-end
sealed later without protocol change, and reserves nested-envelope (onion)
scenarios. The bridge is the two-node degenerate case of that fabric; its named
queues are the fabric's inboxes. (Not to be confused with rclaude's internal
"plan-fabric.md", which is the identity/vocabulary doc -- different Fabric.)

### Decision record (all locked 2026-07-08)

1. Generalized substrate, **frozen** at the verbs in section 4 + the bulk class.
   Growth requires reopening this spec.
2. Sessions are long-lived, outlive connections; lifecycle ops are queued in order,
   so both sides **converge on the same session table by replay** (event-sourced).
   Re-open after loss is silent -- approval is remembered at the grant layer.
3. A2A v1.0.0 **data shapes** kept as the `a2a@1` tenant payload. Honest framing:
   "A2A data model over a custom binding", never "we speak A2A". (A2A section 12
   sanctions custom bindings; its `.proto` is schema-source only -- everything here
   is JSON/binary over WS, plain Bun, no gRPC, no protobuf runtime.)
4. Bulk transfer class fully in v1: offer / accept(memory|file|reject) / credit /
   resume, 256 KiB binary chunks, sha256 verify.
5. Staged handshake: anonymous connect -> capabilities -> auth (negotiable,
   upgradeable; `bearer-key-v1` today) -> direction proofs -> ready.
6. Inline ceiling `maxInline` = 64 KiB default, effective `min(ours, theirs)`;
   bodies above it MUST travel as bulk.
7. Named objects are the consolidation points; connections are 0..N interchangeable
   carriers (per-object sequencing + gap buffer + resync, section 4).
8. `state@1` = Yjs, **spec seam only**, ships v1.1 (nice-to-have, not must-have).
   Fan-out / event feeds are future L3 services, never substrate topics.
9. **Envelope + optional body**, normative: routing on envelope only, body opaque
   to the substrate. Fabric-style multi-hop addresses (`name@gw1@gw2`) and nested
   envelopes are RESERVED grammar; v1 accepts single-segment names only and never
   forwards (onion routing = transitive reach, gated on a future trust/settlement
   model -- cost tokens per the fabric whitepaper).
10. **Futility semantics** (bounce discipline): every failure is classified
    terminal or transient; a frame to a dead/unknown object gets EXACTLY ONE
    terminal `err`, then a tombstone silently swallows the rest; an `err` never
    begets an `err`; senders purge on terminal errors.
11. **Encoding negotiated**: JSON is the mandatory baseline (bootstrap frames are
    always JSON); CBOR (RFC 8949, `cbor-x`) upgrades the channel when both sides
    advertise it -- native byte strings kill the base64 tax on binary bodies.
    Bulk chunks stay raw binary regardless. MessagePack rejected in favor of its
    standards-track cousin (CBOR = the WebAuthn/CTAP2/COSE lineage).

### The frozen line

Explicitly OUT of the substrate, permanently-unless-reopened: topic routing /
fan-out pub-sub, per-message QoS levels, protocol negotiation registries,
compression, general per-session flow control. Flow control exists in exactly one
place: inside the bulk transfer class. Global backpressure = socket + queue caps.

## 2. L1 -- CONNECTIONS

- **Endpoint**: `wss://{host}/bridge/v1`, subprotocol `cw-bridge.v1`. CLAUDEWERK
  side: a new broker route (through Caddy, like all broker WS).
- **0..N connections per peer pair.** Any authenticated connection is an equal
  carrier for the peer's named objects. Zero connections = everything queues.
  Either side may dial whenever it has something to move (config still names a
  preferred dialer for keepalive duty: `dialer: "us" | "them"`).
- **Staged handshake** (SSH-shaped; auth is negotiable so it cannot live in HTTP
  headers):

  1. Anonymous WSS upgrade. Pre-auth budget: one `capabilities` frame each way,
     5s deadline to reach `ready`, per-IP rate limit.
  2. `capabilities` (both directions):
     `{ bindingVersions: [1], authMethods: ["bearer-key-v1"], maxInline: 65536,
     encodings: ["json", "cbor"], features: ["bulk"], peer: "gate" }`. Effective
     binding = highest common version (empty intersection -> close 4002);
     effective `maxInline` = `min(ours, theirs)`; effective encoding = `cbor` iff
     both advertise it, else `json` (the mandatory baseline -- capabilities
     frames themselves are ALWAYS JSON text; the switch applies from `auth`
     onward). Services/endpoints are NOT advertised pre-auth.
  3. `auth` with the chosen method. `bearer-key-v1`: `{ method: "bearer-key-v1",
     key: "brg_..." }` -- the key the receiving side issued. Invalid/revoked ->
     `err code=auth_failed`, close 4004. Enables the sender's direction.
  4. Direction proof for the reverse side: the authenticated side sends
     `{ nonce }`; the other side answers `{ keyProof:
     base64url(hmacSHA256(nonce, <key issued BY the nonce sender>)), keyId }`.
     Valid proof enables the reverse direction; `keyProof: null` = one-way
     channel (frames the other way -> `err code=direction_not_granted`).
  5. `ready`. Queues drain.

- **Keys**: format `brg_<24+ bytes base64url>`, shown once at mint, stored
  **hashed** (SHA-256) by the issuer. CLI-mint only (`broker-cli bridge issue-key
  --peer gate --scopes mention,list`), same rails as `mint-dev-key`, never an
  HTTP/WS mint path. Each key: `peerId`, `scopes`, rate limit, optional project
  allowlist, `status`. Rotation = issue new, deploy, revoke old (overlap allowed).
- **Revocation is live**: issuer sends `revoked { direction }`, drops the
  direction, closes (4003) if both die. Next `auth` with a revoked key fails.
- **Keepalive**: WS ping/pong every 30s from the preferred dialer; kill
  connections silent > 90s. Caddy hops must tolerate the cadence (see
  `stream_close_delay` scar, `.claude/topics/gotchas-runtime.md`).
- **Frames**: control = UTF-8 JSON text frames, or CBOR binary frames after a
  negotiated upgrade (one frame = one message either way); bulk chunks = raw
  binary frames in both modes. Transport frame cap 1 MiB. Under CBOR, binary
  bodies ride as native byte strings (no base64); under JSON, binary bodies
  either base64 (small) or go bulk. The substrate never depends on WebSocket
  specifics -- a raw TCP/TLS carrier with 4-byte length-prefix framing is a
  legal future L1.

## 3. L2 -- named objects and ordering

- **Naming**: `queue/<slug>`, `session/<ulid>`, `state/<slug>` -- each interpreted
  in the namespace of the machine that owns that side; the peer is implied by the
  channel. Raw internal ids (`conv_...`) never appear; conversation-facing names
  are address-book slugs.
- **Address grammar (fabric-reserved)**: endpoint addresses are formally
  `name(@hop)*` per the execution-fabric whitepaper (`recipient@gw1@gw2`). **V1
  accepts single-segment names only**; any `@` in an address -> one terminal
  `err code=routing_not_supported`. The grammar is reserved so a future
  forwarding hop needs no wire change.
- **Per-object sequencing**: the sender stamps each op with a per-object
  monotonic `seq` at enqueue time. Receivers deliver in-seq per object, buffer
  gaps briefly (default 30s), and request `resync { object, fromSeq }` when a gap
  times out -- the sender's durable queue replays from there. This is what makes
  multiple parallel carriers safe.
- **Durability (QoS-1)**: `open`, `send`, `req`, and bulk `offer` persist in the
  sender's per-object FIFO queue until their terminal frame (`accept`/`reject`,
  `ack`, `res`/`end`/`err`, `done`). Dedupe by `(peer, id)` kept >= 7 days;
  duplicates re-acked with the original terminal frame. Queue TTL 24h (expiry
  emits a structured `bridge/expired` event); depth cap 1000 per object
  (`err code=queue_full`); session count cap per peer 200.

## 4. L2 -- the substrate verbs (frozen)

Every message: `{ env: { v: 1, kind, obj?, id?, seq?, ... }, body?: <opaque> }`.
`id` = ULID. ALL routing/control fields live in `env` -- the substrate (queues,
sequencer, dedupe, admission, any future forwarding hop) reads `env` and never
parses `body`. A body is opaque payload for the terminal L3 handler; it may be
JSON, bytes (CBOR byte string), a sealed blob, or a nested envelope+body (onion
seam -- v1 never forwards, see decision 9).

| Frame kind | env fields | Meaning |
|---|---|---|
| `open` | `obj, service, from, to, meta?` | create/attach a session between named endpoints ("I would like a `{service}` session between my `{from}` and your `{to}`") |
| `accept` | `obj` | session live (may arrive long after -- e.g. human approval) |
| `reject` | `obj, code, reason` | terminal per attempt: `unknown_endpoint`, `approval_denied`, `scope_denied`, `unsupported_service`; transient: `rate_limited` |
| `close` | `obj, reason?` | explicit end -- the ONLY way a session dies |
| `send` | `obj?, id` + body | one-way; acked by `ack { id }` |
| `req` | `obj?, id` + body | expects exactly one terminal answer |
| `res` | `id` + body | terminal answer (also the ack) |
| `chunk` | `id` + body | streamed partial answer, zero or more |
| `end` | `id` (+ body?) | stream terminator (terminal) |
| `err` | `id?, obj?, code, final, message` | error frame -- see futility semantics below |

Connection-scope (no `obj`): `ping`, `card/get`, `endpoints/list` -- same
primitives, no special casing. An interrupted `chunk` stream is retried whole by
re-sending the `req` (streams idempotent at L3; dedupe returns the original
terminal for true duplicates).

### Errors and futility (bounce discipline)

Prior art: SMTP's permanent/transient split (5xx/4xx) and its hard-won bounce
rules. Four laws, applying uniformly to every mechanic:

1. **Every failure code is classified** `final: true` (permanent -- retrying is
   futile) or `final: false` (transient -- backoff and retry is legitimate).
   Terminal: `closed`, `unknown_endpoint`, `no_such_object`, `approval_denied`,
   `scope_denied`, `unsupported_service`, `routing_not_supported`,
   `payload_too_large`, `direction_not_granted`, `upgrade_required`,
   `auth_failed`. Transient: `rate_limited`, `queue_full`, `quota`, `busy`.
2. **Exactly one bounce.** The first frame addressed to a dead/unknown object
   answers with one terminal `err { obj, code: "closed", final: true }`; the
   receiver then tombstones that object id (TTL 7d, same store as dedupe) and
   **silently drops** all subsequent frames to it. No error storms.
3. **An `err` never begets an `err`.** Error frames are terminals, never
   re-answered, never bounced -- the mail-loop rule.
4. **Senders honor finality.** On a terminal `err` for an object: purge that
   object's outbound queue, tombstone locally, surface a structured
   `bridge/futile` event. Retrying a tombstoned id is a local bug, not a wire
   event. For sessions, futility attaches to the session ID -- the relationship
   recovers by opening a FRESH session (silent re-open, decision 2), never by
   retrying the dead one. QoS-1 redelivery of the SAME op id is not a retry --
   dedupe re-serves the original terminal answer.

### Bulk transfer class (any-size payloads)

Mandatory for bodies > effective `maxInline`. Admission before bytes:

1. `offer { id, obj?, size, contentType, sha256 }` -- total size declared first.
2. `accept-transfer { id, mode: memory | file | reject, window }` -- the receiver's
   veto (`payload_too_large` = final, `quota` = transient), preallocate, or
   spool-to-file decision, plus the initial credit window (chunks).
3. Binary chunks, 256 KiB, header-tagged `(transferId, offset)` -- interleave with
   control frames so a 2 GB transfer never head-of-line-blocks the pipe.
4. `credit { id, n }` -- receiver-paced; the ONLY flow control in the protocol.
5. `done { id }` after sha256 verify; resume = re-`offer` + `accept-transfer`
   carrying `fromOffset`.

## 5. L3 -- services

### `a2a@1` (v1)

A2A v1.0.0 data shapes (`Message`, `Part` -- text only in v1 -- `Task`,
`TaskStatus`, `AgentCard`) inside sessions; a session maps to an A2A `contextId`.

| A2A operation | Substrate mapping |
|---|---|
| SendMessage | `req { body: { op: "message/send", message } }` -> `res { body: { task } }` |
| Task updates (replaces SSE) | `send { body: { op: "tasks/statusUpdate", taskId, status, result? } }` |
| GetTask / CancelTask | `req { body: { op: "tasks/get" \| "tasks/cancel", taskId } }` |
| Streamed turn output (opt-in later) | `chunk` frames on the `message/send` req |

CLAUDEWERK task-state mapping: `submitted` = queued for the conversation;
`working` = turn active; `input-required` = the conversation asked the peer a
question; `completed` = conversation **settled** (parent-notify settle machinery:
idle + no background sub-agents through the settle window), result = settled
reply; `rejected` = scope/approval/rate denial; `failed` = conversation died;
`canceled` = peer cancel.

### `state@1` (spec seam -- ships v1.1, nice-to-have)

Named `state/<slug>` objects, CRDT-backed with **Yjs**: ops are Yjs binary
updates riding the object's op stream (ordering not required for convergence --
Yjs is a CRDT -- but the substrate provides it anyway); full snapshots ride the
bulk class. No v1 implementation; the kind + encoding are reserved here so
nothing forks.

### Connection-scope built-ins (v1)

`card/get` -> A2A AgentCard (in-band discovery, post-auth only). `endpoints/list`
(scope `list`) -> peer-scoped address book `[{ slug, title, project, state }]` --
only what the key's project allowlist exposes. `ping` -> RTT probe.

Future tenants (event feeds, file drops, presence) = new `service@major` strings
+ L3 handlers. The substrate does not change; fan-out lives in the service, not
in topics.

## 6. CLAUDEWERK implementation mapping

- **Inbound `open` for `a2a@1`** -> resolve `to` slug via address book -> **LINK
  approval gate** (same first-contact banner as inter-session; approvals persist
  in the peer registry) -> `accept`. Inbound `message/send` in an accepted
  session -> `channel_deliver` wrapped in `<channel source="gate" ...>` --
  untrusted framing, existing rendering.
- **Outbound**: a conversation's `send_message` to a `gate:*` slug opens (or
  silently re-opens) the session and sends within it; task updates return as
  channel messages.
- **New pieces**: `src/broker/bridge/` (L1 handshake server + dialer, L2 engine:
  named-object store + queues + sequencer + bulk, L3 a2a handler),
  `bridge_peers` / `bridge_keys` / `bridge_objects` / queue tables,
  `broker-cli bridge` verbs (`add-peer`, `issue-key`, `revoke-key`, `status`),
  WS role `bridge-peer` in the message-router role table.
- **Naming**: this is the **BRIDGE** -- NOT the existing `gateway` role (`gw_`,
  backend adapters/hermes). Key prefix `brg_`.
- **Covenants**: every lifecycle event (connect/auth/proof/ready/disconnect,
  open/accept/reject/close, queue drain/expiry/resync, transfer admission/verify,
  revocation, task transitions) is a typed, persisted, rendered structured
  message with full context.

## 7. Security

1. **Spend-bomb guard**: an inbound bridge message can wake an agent = real
   money. Per-key rate limit (default 10 msgs/min), project allowlist, LINK
   approval at session open -- all three server-side before any agent wakes.
2. **Untrusted content**: peer bodies are data, never instructions -- `<channel>`
   framing end-to-end; no tool authority attaches to bridge traffic.
3. **Pre-auth surface**: one capabilities frame, 5s deadline, per-IP rate limit;
   nothing sensitive advertised before auth.
4. **Key hygiene**: hashed at rest, shown once, CLI-mint only; greppable
   `[bridge]` audit lines for every mint/auth/proof/revoke/reject.
5. **No transitive reach**: v1 scopes = `mention` + `list`. No spawn, no kill,
   no file access, no sentinel verbs over the bridge. Corollary: **no
   forwarding** -- multi-hop addresses and nested envelopes are reserved grammar
   only; acting on them requires a trust/settlement model that does not exist yet.
6. **DoS**: transport frame cap, bulk admission (declared size or no bytes),
   dedupe TTL, queue depth/TTL caps, session cap, gap-buffer timeout.
7. **Bounce storms**: the futility laws (section 4) are load-bearing security --
   exactly-one bounce + tombstones + err-never-begets-err is what stops two
   durable QoS-1 queues from feedback-looping each other to death.

## 8. Prior art (why these choices)

- **SSH connection protocol (RFC 4254)** -- the L1/L2 template: one authenticated
  connection, typed channels opened by request, multiplexed; SFTP's windowed
  transfers = the bulk class's ancestor. Staged caps-then-auth = SSH KEX ordering.
- **A2A v1.0.0** -- L3 data shapes + task lifecycle + agent card; section 12
  sanctions custom bindings. Official `@a2a-js/sdk` rejected (tracks 0.3.x,
  Express-shaped).
- **MQTT** -- QoS-1 + persistent sessions inspired the queue semantics; rejected
  as a protocol (central broker, topics, req/resp bolted on in v5).
- **The execution-fabric whitepaper** ("Claw Gate: The Open Execution Fabric",
  internal research 2026-03) -- envelope/body split, onion encapsulation,
  envelope-and-inbox async, pluggable transports, fabric addresses. The bridge is
  its two-node degenerate case; the reserved grammar keeps them convergent.
- **SMTP** -- permanent/transient failure classes and at-most-once bounce
  discipline; the mail-loop rule (never bounce a bounce).
- **CBOR (RFC 8949)** -- the negotiated binary encoding; chosen over MessagePack
  for the standards-track + WebAuthn/CTAP2/COSE lineage, native byte strings.
- **Yjs** -- the `state@1` encoding: CRDT convergence for named shared objects.
- **LSP** -- symmetric request traffic over one connection, proven at scale.
- **XMPP S2S dialback** -- ancestor of per-direction grants.
- **HTTP/2, AMQP, libp2p, NATS, WAMP, STOMP, graphql-ws** -- surveyed; their
  flow-control windows, topic routing, and negotiation registries are exactly
  the frozen line this spec refuses to cross.
