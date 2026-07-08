# Bridge Protocol v1

**Status: DRAFT rev 5 -- 2026-07-08. Design locked (14 decisions, workshop with Jonas);
security-hardened against a full Opus adversarial audit (19 findings folded);
nothing implemented yet.** Rev 1 bound A2A directly onto the connection -- one layer
too low. Rev 2 = the three-layer, named-object model. Rev 3 adds the normative
envelope/body split (fabric alignment), futility/bounce semantics, and encoding
negotiation (JSON baseline / CBOR upgrade). Rev 4 closes the audit: authorized
finality, receiver-derived error classes, op-id (not name) tombstones, a defined
spend rail, a durable user-stop, a revocation barrier, and a bulk/downgrade/
CBOR/nonce/seq hardening pass (section 9 tracks every finding). Rev 5 adds the
first-class elicit (propose/consent) primitive, star-topology shared artifacts
(multi-party as pairwise-authorized fan-out, no forwarding), and the peer
lifecycle (active/unreachable/severing/terminated with a graceful terminate).

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
    terminal or transient **by the receiver, from the code** (never a wire flag);
    a frame to a dead object gets EXACTLY ONE terminal `err`, then a **per-op-id**
    tombstone silently swallows redelivery of that op; an `err` never begets an
    `err`; senders purge on terminal errors. **Finality is authorized** -- only a
    verified participant may close/kill an object (section 4).
11. **Encoding negotiated**: JSON is the mandatory baseline (bootstrap frames are
    always JSON); CBOR (RFC 8949, `cbor-x`) upgrades the channel when both sides
    advertise it -- native byte strings kill the base64 tax on binary bodies.
    Bulk chunks stay raw binary regardless. MessagePack rejected in favor of its
    standards-track cousin (CBOR = the WebAuthn/CTAP2/COSE lineage).
12. **Elicit is first-class**: `propose`/`consent` (section 4) is a richer,
    explicit consent handshake carrying structured intent (purpose, artifact
    kind, requested scopes, expiry, member list). Bare `open` stays for simple
    2-party sessions; `propose` is used when the human should approve WHAT and
    WHO-ELSE, not just WHO.
13. **Multi-party is STAR, never mesh**: N domains each open a normal pairwise
    session to a shared named object on the hub. Every trust edge is
    self-authorized pairwise; the hub is the trust broker (domains trust the hub,
    not each other). "Broadcast to multiple domains" = the artifact owner relays
    each update to every authorized pairwise session (fan-out-as-L3, N sends, not
    substrate pub-sub -- consistent with decision 8 / the frozen line). Inline
    key/proof introduction (A vouches for C) stays OUT -- that is forwarding /
    delegation, reserved for a future fabric trust+settlement tier (decision 9).
14. **Peer lifecycle** (section 2): a peer moves `active` -> `unreachable`
    (transport lost, queues persist, NEVER auto-terminates) and, on authorization
    severance only, `active`/`unreachable` -> `severing` -> `terminated`.
    `severing` runs a configurable grace window (default 7d) with escalating
    warnings and periodic auth retry; `terminated` tears down all named objects
    for the peer. A graceful `terminate` verb exists; the inferred path is N
    consecutive auth rejections over the window.

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
     5s deadline to reach `ready`, a short pre-auth idle timeout, a **hard global
     cap on concurrent un-`ready` connections**, and a per-client-IP rate limit.
     Behind Caddy every socket shows the proxy IP, so the client IP is read from
     the trusted forwarded header of the KNOWN Caddy hop only -- never a
     client-spoofable `X-Forwarded-For` (MED-13).
  2. `capabilities` (both directions):
     `{ bindingVersions: [1], authMethods: ["bearer-key-v1"], maxInline: 65536,
     encodings: ["json", "cbor"], features: ["bulk"], peer: "gate" }`. Effective
     binding = highest common version (empty intersection -> close 4002);
     effective `maxInline` = `min(ours, theirs)`; effective encoding = `cbor` iff
     both advertise it, else `json` (the mandatory baseline -- capabilities
     frames themselves are ALWAYS JSON text; the switch applies from `auth`
     onward). Services/endpoints are NOT advertised pre-auth. The pre-auth `peer`
     name is an untrusted hint; the authoritative peer identity is `key.peerId`
     resolved at auth, and ALL peer-scoping uses that (MED-14).
  3. `auth` with the chosen method. `bearer-key-v1`: `{ method: "bearer-key-v1",
     key: "brg_..." }` -- the key the receiving side issued. Invalid/revoked ->
     `err code=auth_failed`, close 4004. Enables the sender's direction.
  4. Direction proof for the reverse side. **Both directions use
     challenge-response** so no bearer secret is transmitted in the clear more
     than the forward `auth` already requires; the challenged side proves the key
     it was ISSUED without sending it. The challenger sends `{ nonce }`; the other
     answers `{ keyProof, keyId }` where
     `keyProof = base64url(hmacSHA256(transcript, <key issued BY the nonce sender>))`
     and `transcript = nonce || "\x00cw-bridge/dir-proof/v1\x00" || direction ||
     H(myCaps) || H(peerCaps) || resolved{bindingVersion,encoding,authMethod}`.
     Folding the negotiated tuple + both caps frames into the HMAC input **binds
     the proof to this connection and defeats downgrade tampering** (the
     SSH-exchange-hash / TLS-Finished property, previously missing -- HIGH-8).
     `nonce` MUST be >= 16 bytes from a CSPRNG (`crypto.getRandomValues` /
     `randomBytes` -- never `Math.random`), single-use, bound to the pending
     connection, time-boxed to the 5s budget (MED-10). The bridge HMAC key is
     used for NOTHING else (no signing-oracle reuse). `keyProof: null` = one-way
     channel (frames the other way -> `err code=direction_not_granted`).
  5. `ready`. Queues drain. If either side's echoed resolved tuple mismatches what
     it computed, abort (close 4002) before `ready` -- no traffic on a downgraded
     channel.

- **Keys**: format `brg_<24+ bytes base64url>`, shown once at mint, stored
  **hashed** (SHA-256) by the issuer. CLI-mint only (`broker-cli bridge issue-key
  --peer gate --scopes mention,list`), same rails as `mint-dev-key`, never an
  HTTP/WS mint path. Each key: `peerId`, `scopes`, rate limit, optional project
  allowlist, `status`. Rotation = issue new, deploy, revoke old (overlap allowed).
- **Keys** also carry a mandatory `expiresAt` (bounded lifetime; rotation overlap
  is a short window, not forever -- LOW-17). The **scope->verb matrix** is fixed
  and enforced per-frame, not only at open: `list` -> `endpoints/list`; `mention`
  -> `open` / `send` / `req` on a `mention`-scoped session. A frame outside the
  key's scopes -> `err code=scope_denied` (final).
- **Revocation barrier (HIGH-6)**: revocation is live AND synchronous. The issuer
  sends `revoked { direction }`, then: (a) invalidates that direction on ALL live
  connections for the key at once, (b) **drops undelivered inbound queued ops**
  originated by the revoked key/direction, (c) the key/scope is **re-validated at
  agent-wake time**, not only at session open -- so an op already in the pipeline
  cannot wake an agent after revocation lands. Closes (4003) if both directions
  die. Next `auth` with a revoked/expired key fails.
- **Peer lifecycle (decision 14)**: a per-peer-pair state ABOVE individual
  objects. The cardinal rule: **loss of connectivity is NOT loss of
  authorization.** Durable queues exist to survive disconnection, so an
  unreachable peer must NEVER auto-terminate.

  ```
  active  --transport lost-->  unreachable  --reconnect-->  active
     (queues/sessions/state persist indefinitely; NO teardown)
  active | unreachable  --auth severed-->  severing  --re-authorized-->  active
     severing: grace window (configurable, default 7d) + escalating
               warnings (bridge/severing events, user-surfaced) + periodic auth retry
  severing  --grace expires | mutual terminate-->  TERMINATED
     tear down ALL queues/sessions/state for the peer; purge durable
     data + tombstones; terminal bridge/terminated event. A newly issued
     key is a FRESH relationship, not a resurrection.
  ```

  **Auth-severed** is the ONLY trigger into `severing`: an explicit `terminate`/
  `revoked` from the peer (graceful path), OR N consecutive `auth_failed` /
  `direction_not_granted` across reconnect attempts (inferred path, for a peer
  that just deletes the key and 401s). The severed side runs its OWN grace clock
  and owns its cleanup; during `severing` a human can re-issue the key (-> back to
  `active`) or confirm teardown early. `unreachable` never enters `severing` --
  only an authorization signal does.
- **Keepalive**: WS ping/pong every 30s from the preferred dialer; kill
  connections silent > 90s. Caddy hops must tolerate the cadence (see
  `stream_close_delay` scar, `.claude/topics/gotchas-runtime.md`).
- **Frames**: control = UTF-8 JSON text frames, or CBOR binary frames after a
  negotiated upgrade (one frame = one message either way); bulk chunks = raw
  binary frames in both modes. In CBOR mode both control and chunks are binary
  WS frames, so every binary frame carries a **1-byte leading discriminator**
  (`0x01` = control message, `0x02` = bulk chunk) resolved BEFORE any decode --
  the receiver never guesses by trial-parsing (MED-9). Transport frame cap 1 MiB.
  The CBOR decoder (`cbor-x`) is hardened: max nesting depth, max collection
  size, size cap before decode, no tag->class instantiation, reject
  indefinite-length and duplicate keys; JSON parsing gets the same depth cap.
  Under CBOR, binary bodies ride as native byte strings (no base64); under JSON,
  binary bodies either base64 (small) or go bulk. The substrate never depends on
  WebSocket specifics -- a raw TCP/TLS carrier with 4-byte length-prefix framing
  is a legal future L1.

## 3. L2 -- named objects and ordering

- **Naming**: `queue/<slug>`, `session/<ulid>`, `state/<slug>` -- each interpreted
  in the namespace of the machine that owns that side; the peer is implied by the
  channel. Raw internal ids (`conv_...`) never appear; conversation-facing names
  are address-book slugs.
- **Slug charset (normative)**: object slugs and `from`/`to`/`obj` addresses match
  `[a-z0-9._-]{1,128}` ONLY, evaluated after Unicode normalization. Anything
  else -> reject the WHOLE frame. This closes homoglyph/escape smuggling and
  keeps names filesystem-safe (MED-14/15).
- **Address grammar (fabric-reserved)**: endpoint addresses are formally
  `name(@hop)*` per the execution-fabric whitepaper (`recipient@gw1@gw2`). **V1
  accepts single-segment names only**; an `@` (or any out-of-charset byte) in
  ANY address field (`to`, `from`, `obj`) -> one terminal
  `err code=routing_not_supported`, checked after normalization, before the name
  is stored/echoed/logged (MED-15). The grammar is reserved so a future
  forwarding hop needs no wire change; v1 L3 handlers treat a nested-envelope
  body as opaque data and never parse it as routing.
- **Per-object sequencing**: the sender stamps each op with a per-object
  monotonic `seq` from a **single seq authority per object per direction** (a
  shared atomic counter, even across parallel sender connections -- never
  per-connection). Receivers deliver in-seq per object and **only buffer seqs
  inside a bounded window** `[nextExpected, nextExpected + W]`; an out-of-window
  seq (far-future gap-poison, MED-11) is rejected with `err code=out_of_seq`
  rather than buffered, so no single frame can wedge delivery. Gaps buffer
  briefly (default 30s), then `resync { object, fromSeq }` replays from there --
  `fromSeq` MUST be `>= tombstoneHorizon` and `<= current`, and resync itself is
  rate-limited, so a peer cannot force unbounded whole-queue replay.
- **Durability (QoS-1)**: `open`, `send`, `req`, and bulk `offer` persist in the
  sender's per-object FIFO queue until their terminal frame (`accept`/`reject`,
  `ack`, `res`/`end`/`err`, `done`). Dedupe by `(peer, id)` kept >= 7 days;
  duplicates re-acked with the original terminal frame. **Dedupe wins over
  tombstone (MED-12)**: a redelivery of a KNOWN op `id` always re-serves the
  stored terminal (so a sender that lost the answer converges); the silent-drop
  of futility law 2 applies only to NEW ids arriving at a dead object. Queue TTL
  24h (expiry emits a structured `bridge/expired` event); depth cap 1000 per
  object (`err code=queue_full`); session count cap per peer 200.

## 4. L2 -- the substrate verbs (frozen)

Every message: `{ env: { v: 1, kind, obj?, id?, seq?, ... }, body?: <opaque> }`.
`id` = ULID. ALL routing/control fields live in `env` -- the substrate (queues,
sequencer, dedupe, admission, any future forwarding hop) reads `env` and never
parses `body`. A body is opaque payload for the terminal L3 handler; it may be
JSON, bytes (CBOR byte string), a sealed blob, or a nested envelope+body (onion
seam -- v1 never forwards, see decision 9).

| Frame kind | env fields | Meaning |
|---|---|---|
| `open` | `obj, service, from, to, meta?` | bare 2-party session open ("I would like a `{service}` session between my `{from}` and your `{to}`"). Implicit consent handshake -- answered by `accept`/`reject` |
| `propose` | `obj, service, from, to` + body | **elicit** (decision 12): explicit consent request. Body = structured intent `{ purpose, artifactKind, scopes[], expiresAt, members[] }`. Surfaces WHAT + WHO-ELSE at the approval banner |
| `consent` | `obj, decision` | answer to a `propose`: `decision = accept \| decline`; `decline` carries a code |
| `accept` | `obj` | session live (may arrive long after -- e.g. human approval) |
| `reject` | `obj, code, reason` | answer to a specific `open` attempt (carries the attempt's `id`); codes: `unknown_endpoint`, `approval_denied`, `scope_denied`, `unsupported_service`, `rate_limited` |
| `close` | `obj, reason?` | explicit end -- the ONLY way a session dies. **Honored only from a verified participant** of that session (CRIT-1) |
| `terminate` | `reason?` | connection-scope: graceful peer goodbye ("you are no longer a client"). Drives the peer to `severing`->`terminated` (decision 14) |
| `send` | `obj?, id` + body | one-way; acked by `ack { id }` |
| `req` | `obj?, id` + body | expects exactly one terminal answer |
| `res` | `id` + body | terminal answer (also the ack) |
| `chunk` | `id` + body | streamed partial answer, zero or more |
| `end` | `id` (+ body?) | stream terminator (terminal) |
| `err` | `id?, obj?, code, message` | error frame -- NO `final` field; class is derived from `code` by the receiver (CRIT-2). See futility semantics below |

Connection-scope (no `obj`): `ping`, `card/get`, `endpoints/list`, `terminate` --
same primitives, no special casing. An interrupted `chunk` stream is retried whole
by re-sending the `req` (streams idempotent at L3; dedupe returns the original
terminal for true duplicates).

`open` vs `propose`: `open` is the lightweight 2-party path (implicit "attach a
session, ok?"); `propose` is the first-class elicit for anything a human should
weigh -- a shared multi-party artifact, elevated scopes, an expiring grant. Both
land on the same LINK approval gate; `propose` just gives the banner the intent +
member list to show.

### Errors and futility (bounce discipline)

Prior art: SMTP's permanent/transient split (5xx/4xx) and its hard-won bounce
rules -- but SMTP tombstones a *message*, never a *recipient forever*; rev 4
keeps that distinction (HIGH-3). Five laws, applying uniformly to every mechanic:

1. **Class is derived by the RECEIVER from the code**, via this fixed table --
   the wire carries no `final` flag a peer could forge (CRIT-2). Disjoint codes
   (INFO-19): `unknown_endpoint` (address-book miss), `no_such_object` (id never
   existed), `closed` (object was explicitly closed by a participant).
   **Terminal**: `closed`, `unknown_endpoint`, `no_such_object`,
   `approval_denied`, `scope_denied`, `unsupported_service`,
   `routing_not_supported`, `payload_too_large`, `direction_not_granted`,
   `upgrade_required`, `auth_failed`, `out_of_seq`, `sha256_mismatch`.
   **Transient**: `rate_limited`, `queue_full`, `quota`, `busy`.
2. **Finality is authorized (CRIT-1).** An inbound `err`/`close` may purge or
   tombstone an object ONLY if its sender is a **verified participant** of that
   object -- a session party, or the declared counterparty of that queue --
   checked server-side against `key.peerId` + the session table, never against a
   client-asserted `obj` name alone. A finality frame from a non-participant is
   itself dropped. This is what stops any authenticated peer from silently
   censoring channels it can merely name.
3. **Exactly one bounce, tombstoned by OP-ID not by NAME (HIGH-3).** The first
   frame carrying an `id` that targets a dead/unknown object answers with one
   terminal `err { id, obj, code: "closed" | "no_such_object" }`; the receiver
   then tombstones **that op `id`** (TTL 7d, dedupe store) and silently swallows
   only redelivery of that same id. A stray frame to an unknown NAME never
   blackholes the name -- a later legitimate `open`/create re-activates it.
   (Ephemeral session ULIDs are the one case a name-tombstone is acceptable,
   because the id is never reused.)
4. **An `err` never begets an `err`.** Error frames are terminals, never
   re-answered, never bounced -- the mail-loop rule. This is what stops two
   durable QoS-1 queues from feedback-looping each other to death.
5. **Senders honor finality.** On a terminal `err` for an op: purge that op from
   the outbound queue, surface a structured `bridge/futile` event. For a session
   that a participant `close`d, futility attaches to the session ID -- the
   relationship recovers by opening a FRESH session (subject to the durable
   user-stop block, section 6), never by retrying the dead one. QoS-1 redelivery
   of the SAME op id is not a retry -- dedupe re-serves the stored terminal
   (dedupe wins over tombstone, section 3).

### Bulk transfer class (any-size payloads)

Mandatory for bodies > effective `maxInline`. Admission before bytes:

1. `offer { id, obj?, size, contentType, sha256 }` -- total size declared first.
   `contentType` is an allowlisted enum that only ever selects a SAFE handler;
   an unknown/dangerous type is refused, never used to pick a renderer (MED-14).
2. `accept-transfer { id, mode: memory | file | reject, window }` -- the receiver's
   veto (`payload_too_large` = terminal, `quota` = transient), preallocate, or
   spool-to-file decision, plus the initial credit window (chunks). The receiver
   **never preallocates the attacker-declared `size`** -- buffers grow
   incrementally to a hard cap; `file` mode spools to a **server-generated random
   filename in an isolated temp dir**, never a path derived from any client field
   (no traversal -- HIGH-7). Per-peer quotas gate admission: max concurrent
   transfers, max total in-flight bytes, max disk. An idle transfer (accepted,
   no chunks) times out and is cleaned up.
3. Binary chunks, 256 KiB, header-tagged `(transferId, offset)` -- interleave with
   control frames so a 2 GB transfer never head-of-line-blocks the pipe. A chunk
   whose bytes would exceed declared `size`, or whose `offset` is out of the
   received range, is rejected.
4. `credit { id, n }` -- receiver-paced; the ONLY flow control in the protocol.
5. `done { id }` after sha256 verify. A hash mismatch -> `err code=sha256_mismatch`
   (terminal) and the partial spool file is deleted. Resume = re-`offer` +
   `accept-transfer` carrying `fromOffset`, validated `<= bytesReceived` (no
   rewind/overlap past what was stored).

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

**Star topology for multi-party shared artifacts (decision 13).** A `state@1`
object shared across several domains is NOT a mesh session and carries NO
multi-party wire construct. Each domain opens (via `propose`) a normal **pairwise**
session to the shared object on the hub; membership is the `propose` body's
`members[]` and each edge is authorized pairwise (LINK approval on the hub side).
The hub is the trust broker -- domains trust the hub, not each other; a domain
never presents proof for another domain (that would be forwarding/delegation,
reserved as a future fabric tier per decision 9).

**Broadcast = fan-out-as-L3, not substrate pub-sub.** When domain X mutates the
artifact, the hub (the object owner) relays that Yjs update to every OTHER
currently-authorized pairwise session -- N ordinary `send`s, one per member, over
the substrate's normal per-object streams. There is no topic, no substrate
subscription (consistent with the frozen line). Membership changes (a domain
joining/leaving) are themselves fan-out events, so every member sees the roster.
Because X's changes become visible to Y THROUGH the hub, joining a shared artifact
is explicit **consent to co-participation** -- which is exactly what the `propose`
member list surfaces at the approval banner.

### Connection-scope built-ins (v1)

`card/get` -> A2A AgentCard (in-band discovery, post-auth only). `endpoints/list`
(scope `list`) -> peer-scoped address book `[{ slug, title, project, state }]` --
only what the key's project allowlist exposes. `ping` -> RTT probe.

Future tenants (event feeds, file drops, presence) = new `service@major` strings
+ L3 handlers. The substrate does not change; fan-out lives in the service, not
in topics.

## 6. CLAUDEWERK implementation mapping

- **Inbound `open` for `a2a@1`** -> check the **durable user-stop block** first
  (HIGH-5): a user "close" that was an intent-to-stop (or a "deny/block peer"
  action) persists in the peer registry and a fresh `open` MUST honor it ->
  `reject code=approval_denied`. Otherwise resolve `to` slug via address book ->
  **LINK approval gate** (same first-contact banner as inter-session; approvals
  persist in the peer registry) -> `accept`. Inbound `message/send` in an
  accepted session -> `channel_deliver` wrapped in `<channel source="gate"
  from="{peer.from -- untrusted, namespaced}" ...>` -- the peer-asserted `from`
  is display-only, prefixed as peer-controlled, NEVER conflated with a local
  trusted identity (MED-14); untrusted framing, existing rendering.
- **Two kinds of close (HIGH-5)**: a transport-loss disconnect is silent and the
  session silently re-opens with remembered approval; a USER-initiated close/deny
  writes a durable block that silent re-open honors until the user lifts it. A
  runaway peer cannot resurrect a session the user killed by minting a fresh
  session id -- only lifting the block or a new LINK approval re-enables it.
- **Outbound**: a conversation's `send_message` to a `gate:*` slug opens (or
  silently re-opens, if not user-blocked) the session and sends within it; task
  updates return as channel messages.
- **New pieces**: `src/broker/bridge/` (L1 handshake server + dialer, L2 engine:
  named-object store + queues + sequencer + bulk, L3 a2a handler), the SQLite
  tables of section 8 (`bridge_peers` / `bridge_keys` / `bridge_objects` /
  `bridge_outbox` / `bridge_dedupe`) + the bulk spool dir, `broker-cli bridge`
  verbs (`add-peer`, `issue-key`, `revoke-key`, `status`, `terminate-peer`),
  WS role `bridge-peer` in the message-router role table.
- **Naming**: this is the **BRIDGE** -- NOT the existing `gateway` role (`gw_`,
  backend adapters/hermes). Key prefix `brg_`.
- **Covenants**: every lifecycle event (connect/auth/proof/ready/disconnect,
  open/accept/reject/close, queue drain/expiry/resync, transfer admission/verify,
  revocation, task transitions) is a typed, persisted, rendered structured
  message with full context.

## 7. Security

1. **Spend-bomb guard (HIGH-4)**: an inbound frame can wake an agent = real money.
   The **agent-waking frame set is enumerated**: `message/send`, and any `req`/
   `send` op that reaches `channel_deliver`. EVERY such frame is metered by a
   **per-key rolling-window rate limit (default 10/min)** and re-checks project
   allowlist + key validity **at wake time, before the wake** -- NOT merely at
   session open. One approved `open` does NOT grant unlimited post-approval sends;
   each waking frame is counted. Control frames (`open`, `err`, `close`, `resync`,
   `offer`) carry a **separate, stricter budget** (LOW-16) so a control flood
   cannot drive the CRIT-1/HIGH-3/MED-11 abuses at volume.
2. **Untrusted content**: peer bodies are data, never instructions -- `<channel>`
   framing end-to-end; no tool authority attaches to bridge traffic. **LINK
   approval is WHO-only (INFO-18)**: it authorizes a peer/endpoint pair, never
   inspects body content, and once bodies are sealed no content defense can be
   added -- so the protocol reserves the right to refuse sealed bodies from
   un-approved / low-trust peers.
3. **Pre-auth surface**: one capabilities frame, 5s deadline, pre-auth idle
   timeout, global concurrent-un-`ready` cap, per-client-IP rate limit read from
   the trusted Caddy hop only (MED-13); nothing sensitive advertised before auth.
4. **Key hygiene**: hashed at rest, shown once, CLI-mint only, mandatory expiry;
   greppable `[bridge]` audit lines for every mint/auth/proof/revoke/reject.
   Downgrade-bound direction proofs (section 2) + single-purpose HMAC key.
5. **No transitive reach**: v1 scopes = `mention` + `list`, enforced per-frame via
   the fixed scope->verb matrix. No spawn, no kill, no file access, no sentinel
   verbs over the bridge. Corollary: **no forwarding** -- multi-hop addresses and
   nested envelopes are reserved grammar only; acting on them requires a
   trust/settlement model that does not exist yet.
6. **Authorized finality (CRIT-1/2, HIGH-3)**: close/kill of an object requires a
   verified participant; error class is receiver-derived from the code; tombstones
   are per-op-id, so no peer can censor a named channel or forge a retry storm.
7. **Revocation barrier (HIGH-6)**: revoke invalidates all live connections
   synchronously, drops queued inbound ops, re-validates at wake time -- an
   in-flight op cannot wake an agent after revocation.
8. **DoS**: transport frame cap, hardened decoder (depth/size caps), bulk
   admission with per-peer disk/byte/concurrency quotas + no attacker-sized
   prealloc + idle timeout, bounded seq window + rate-limited resync, dedupe/
   tombstone TTL, queue depth/TTL caps, session cap, gap-buffer timeout.
9. **Bounce storms**: the futility laws (section 4) are load-bearing security --
   exactly-one bounce + per-op-id tombstones + err-never-begets-err is what stops
   two durable QoS-1 queues from feedback-looping each other to death.
10. **Peer teardown never triggers on connectivity (decision 14)**: only an
    authorization signal (`terminate`/`revoked`, or N inferred auth rejections)
    moves a peer to `severing`->`terminated`. An unreachable peer keeps its
    durable state forever. This prevents both a data-loss DoS (partition != purge)
    and a stuck-forever relationship (a real severance is reclaimed after the
    grace window).

## 8. Persistence (SQLite, `bun:sqlite`)

Every durable structure is SQLite (`store.db` family, WAL, strict mode -- the
same engine the broker already uses; bind keys with `{strict:true}` and no `$`
prefix per the repo's bun:sqlite conventions). The wire spec above is
storage-agnostic, but the reference implementation is SQLite and the schema is
what makes QoS-1 real:

- **`bridge_peers`** -- one row per peer: `peerId`, `baseUrl?`, `dialer`,
  `lifecycleState` (active/unreachable/severing/terminated), `severingSince?`,
  `graceMs`, user-stop block flags.
- **`bridge_keys`** -- issued/held keys: hashed key, `direction`, `scopes`,
  `rateLimit`, `projectAllowlist?`, `expiresAt`, `status`.
- **`bridge_objects`** -- named objects: `(peerId, name)` PK, `kind`, `nextSeq`
  (the single seq authority), session party set / membership, `state`.
- **`bridge_outbox`** -- the durable QoS-1 send queue: `(peerId, objName, seq)`,
  `opId`, `kind`, **`bodyInline BLOB?`** for small bodies, **`bodyRef TEXT?`** for
  large ones (a path into the bulk spool dir), `enqueuedAt`, `deliveredAt?`,
  `terminalFrame?` (the stored answer that dedupe re-serves). A `send`/`req`/
  `open`/`offer` is durable the instant it is COMMITTED here, before it hits the
  socket -- that is the QoS-1 write. Drain = read undelivered rows in `seq` order
  and emit; ack/terminal marks the row done.
- **`bridge_dedupe`** -- `(peerId, opId)` -> stored terminal + `tombstonedAt?`,
  TTL 7d. Dedupe re-serve and per-op-id tombstone both live here (dedupe wins,
  section 3).

**Small inline / large file-ref split** is exactly your instinct and it mirrors
the wire `maxInline` line: a body <= `maxInline` is stored inline in
`bodyInline`; anything larger never enters the DB as a blob -- it lives in the
bulk spool dir (server-generated path, section 4) and the row holds only
`bodyRef`. So the durable queue stays small and index-friendly regardless of
payload size, and bulk transfers are resumable from the same spool the row
points at. Writes are transactional (row + seq bump in one tx); a crash mid-send
replays from the outbox on reconnect -- no lost, no double-woken agent (dedupe
covers the redelivery).

## 9. Security audit trail (rev 4)

Opus adversarial audit of rev 3, 2026-07-08. Every finding folded; the blast-radius
scoping (`mention`+`list`, no forwarding) and per-peer dedupe namespacing were
confirmed SOLID and kept as-is.

| # | Sev | Finding | Fix location |
|---|---|---|---|
| 1 | CRIT | Forged `close`/`err` black-holes any named object | §4 futility law 2 (authorized finality) |
| 2 | CRIT | Wire `final` flag self-contradicts code class | §4 verbs (`err` loses `final`) + law 1 |
| 3 | HIGH | Tombstone-by-name blackholes reusable slugs | §4 law 3 (per-op-id) + §3 |
| 4 | HIGH | Spend rail undefined (per-open vs per-wake) | §7.1 (enumerated waking set, per-wake meter) |
| 5 | HIGH | Silent re-open resurrects user-killed session | §6 (durable user-stop block) |
| 6 | HIGH | Revocation races / no wake-time re-check | §2 (revocation barrier) |
| 7 | HIGH | Bulk spool path/quota/prealloc/idle/sha | §4 bulk (server paths, quotas, no prealloc) |
| 8 | HIGH | No downgrade protection on negotiation | §2 step 4 (tuple+caps bound into proof) |
| 9 | MED | CBOR collapses control/chunk discriminator | §2 frames (1-byte discriminator + hardened decoder) |
| 10 | MED | Nonce source / proof binding underspecified | §2 step 4 (CSPRNG, single-use, domain-sep) |
| 11 | MED | `seq`/`resync`/`fromSeq` unbounded | §3 (bounded seq window, resync bounds) |
| 12 | MED | Dedupe vs tombstone contradiction | §3 (dedupe wins for known ids) |
| 13 | MED | Per-IP limit broken behind Caddy; slowloris | §2 step 1 + §7.3 (trusted fwd-IP, preauth cap) |
| 14 | MED | Untrusted `from`/`contentType`/`meta`/`peer` | §2 step 2, §6, §4 bulk (peerId auth, enums) |
| 15 | MED | `@`-reject coverage + slug charset | §3 (charset allowlist, all address fields) |
| 16 | LOW | Control-frame flood + approval fatigue | §7.1 (separate control budget); §6 peer block |
| 17 | LOW | No key expiry; scope->verb matrix unstated | §2 (expiry, matrix) |
| 18 | INFO | LINK approval is WHO-only (seal caveat) | §7.2 |
| 19 | INFO | Overlapping error codes; `busy` unused | §4 law 1 (disjoint codes) |

## 10. Prior art (why these choices)

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
