# Bridge Protocol v1 ("a2a-ws")

**Status: DRAFT -- direction blessed 2026-07-08.** Nothing below is implemented yet.

Service-to-service bridge between CLAUDEWERK (the broker at `concentrator.frst.dev`)
and remote peer systems. First peer: **GATE**. Either side can address ("mention") a
conversation on the other side and receive asynchronous replies. Reach is granted
per direction via independently revocable API keys.

## 1. Decision record

| Decision | Choice |
|---|---|
| Semantics | **A2A v1.0.0** data model + operations (agent cards, messages, tasks, task states) |
| Binding | **Custom WebSocket binding** ("a2a-ws") -- explicitly permitted by A2A spec section 12 (Custom Protocol Bindings). NOT the HTTP+JSON-RPC, REST, or gRPC bindings |
| Framing | JSON-RPC 2.0, used **symmetrically** (both peers send requests on the same socket, LSP-style) |
| Reliability | At-least-once + `messageId` dedupe + durable per-peer outbound queue (MQTT QoS-1 / persistent-session semantics, without MQTT's central-broker topology) |
| Push | Queued JSON-RPC notifications over the socket. **No webhooks** |
| Auth | Mutual, per-direction revocable API keys (`brg_` prefix), minted CLI-only, hashed at rest |
| Version pin | Spec hand-rolled on both sides against A2A 1.0.0 data shapes; binding versioned separately, hard-gated |

Cost accepted knowingly: a custom binding means off-the-shelf A2A clients cannot talk
to us directly. Because the data model is unchanged, the standard HTTP binding can be
added later as a second front door without touching bridge internals.

Protobuf/gRPC note: A2A's `.proto` file is the *normative schema source*, not a wire
requirement. This binding serializes those shapes as JSON. No protobuf runtime, no
gRPC -- plain Bun (`Bun.serve` websockets, native `WebSocket` client).

## 2. Terminology

- **PEER** -- a remote system bridged to CLAUDEWERK (e.g. GATE). One registry record per peer.
- **DIALER / LISTENER** -- per peer pair, exactly ONE side is configured to dial
  (`dialer: "us" | "them"`); the other listens. Roles affect only connection
  establishment -- once the channel is up, the protocol is fully symmetric.
- **DIRECTION GRANT** -- authorization for one direction of traffic (A may send to B).
  Embodied by an API key issued by the receiving side. Two grants = full duplex.
- **CHANNEL** -- the single authenticated WSS connection carrying both directions.

## 3. Relationship to A2A v1.0.0

Kept verbatim: `Message`, `Part` (text only in v1), `Task`, `TaskStatus`, task state
enum, `AgentCard` shapes, operation semantics of `SendMessage` / `GetTask` /
`CancelTask`.

Deviations (all documented, all binding-level or namespaced extensions):

1. **Transport**: WebSocket channel instead of HTTP request/response. Streaming
   (`SendStreamingMessage`, `SubscribeToTask`) is replaced by task update
   *notifications* pushed over the channel -- same events SSE would carry.
2. **Push notification config CRUD** (A2A 3.1.7-3.1.10) is dropped -- push is
   inherent to the channel.
3. **Conversation addressing**: A2A addresses an *agent*. We target a specific
   conversation via `message.metadata.conversation` (address-book slug, never a raw
   `conv_` id). Namespaced as extension `dev.frst.bridge/conversation`.
4. **Discovery**: agent card is exchanged in-band (`card/get`) after auth. Serving
   it additionally at `/.well-known/agent-card.json` is optional and deferred.

## 4. Transport and connection lifecycle

- **Endpoint**: `wss://{host}/bridge/v1`, WebSocket subprotocol `a2a-ws.v1`.
  CLAUDEWERK's listener is a new route on the broker (through Caddy, like all WS).
- **One channel per peer pair.** If a duplicate connection authenticates for the same
  peer, the listener closes the OLD channel (code 4001 `superseded`) and adopts the
  new one -- the dialer's reconnect is always authoritative.
- **Reconnect** (dialer): exponential backoff with full jitter, 1s base, 60s cap,
  forever. Queued traffic survives disconnects (section 7); there is no session
  resume handshake -- the queues ARE the session state.
- **Keepalive**: transport-level WS ping/pong every 30s from the dialer, plus the
  listener kills channels silent for > 90s. App-level `ping` request exists for
  explicit RTT/liveness probes but is not required traffic. Both Caddy hops must be
  configured to tolerate this cadence (see the `stream_close_delay` scar in
  `.claude/topics/gotchas-runtime.md`).
- **Frames**: UTF-8 text, one JSON-RPC message per frame, max 1 MiB. Oversize =
  error `-32011 payload_too_large`, channel stays up.

## 5. Authentication -- mutual direction grants

### Keys

- Format `brg_<24+ bytes base64url>`, shown once at mint, stored **hashed** (SHA-256)
  by the issuer. The holder stores it like any credential (GATE side: its config;
  CLAUDEWERK side: encrypted in the peer registry).
- Minted CLI-only, same rails as `mint-dev-key`: `broker-cli bridge issue-key --peer
  gate --scopes mention,list`. **Never an HTTP/WS mint path.**
- Each key carries: `peerId`, `scopes`, per-key **rate limit**, optional **project
  allowlist**, `status: active | revoked`.
- Rotation: issue new, deploy on peer, revoke old. Two active keys per direction are
  allowed during overlap.

### Handshake (mutual proof on one socket)

TLS authenticates the listener's domain. The two grants are proven in-band:

1. Dialer connects with `Authorization: Bearer brg_...` (the key the LISTENER
   issued). Invalid/revoked -> HTTP 401, no upgrade. This enables the
   **dialer -> listener** direction.
2. Dialer sends `hello` request: `{ bindingVersion: 1, peer: "gate", nonce:
   "<32B base64url>" }`.
3. Listener replies with `{ bindingVersion: 1, peer: "claudewerk", keyProof:
   base64url(hmacSHA256(nonce, <key the DIALER issued to the listener>)),
   keyId: "<prefix8>" }`. A valid proof enables the **listener -> dialer** direction.
   The raw reverse key never crosses the wire; a logged frame cannot be replayed
   against a fresh nonce.
4. Either direction may be absent: `keyProof: null` means the listener holds no
   (valid) grant, and the channel runs one-way. Traffic in an un-granted direction
   is rejected with `-32013 direction_not_granted`.

### Revocation

Revoking a key takes effect live: the issuer sends notification `bridge/revoked`
`{ direction }` and drops that direction immediately; if both directions are dead it
closes the channel (code 4003 `revoked`). Next dial with a revoked key -> 401.
Either side can also simply delete the key it *holds* -- no coordination required.

### Version gate

`bindingVersion` mismatch in `hello` -> error `-32010 upgrade_required` carrying both
versions, then close (code 4002). **No negotiation, no translation** -- same hard-gate
covenant as `AGENT_HOST_PROTOCOL_VERSION`.

## 6. Framing -- symmetric JSON-RPC 2.0

Standard JSON-RPC 2.0 objects. Both peers run a dispatcher; either side may send
requests once its direction is granted (prior art: LSP, where server->client requests
are routine). Request `id` = ULID string, unique per sender. Notifications (no `id`)
carry events. Batch arrays are NOT supported.

Method namespaces:

| Namespace | Layer |
|---|---|
| `hello`, `ping`, `bridge/*` | binding/channel control |
| `message/*`, `tasks/*`, `card/*` | A2A operations |
| `conversations/*` | CLAUDEWERK extension (scoped address book) |

## 7. Reliability -- QoS-1 semantics

- **At-least-once**: every `message/send` params object carries a sender-generated
  `messageId` (ULID). The JSON-RPC response is the delivery ack.
- **Dedupe**: receivers keep `(peerId, messageId)` for >= 7 days; a duplicate is
  re-acked with the ORIGINAL result and not re-delivered.
- **Durable outbound queue** per peer, per direction: sends while the channel is
  down (or before an ack) are persisted and drained FIFO on reconnect. Default TTL
  24h; expiry emits a local `bridge/expired` event (structured message, visible in
  the control panel). Task update notifications queue the same way; only the LATEST
  status per task is retained (state supersedes state).
- **Ordering**: FIFO per direction per peer -- guaranteed by the single channel plus
  the FIFO queue. No cross-peer ordering.

## 8. V1 operations

### `message/send` (A2A SendMessage)

Request (GATE -> CLAUDEWERK):

```json
{
  "jsonrpc": "2.0", "id": "01JZ...",
  "method": "message/send",
  "params": {
    "messageId": "01JZ...",
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "Deploy is green, proceed?" }],
      "metadata": { "dev.frst.bridge/conversation": "nightshift-engine", "intent": "request" }
    }
  }
}
```

Response: `{ "task": { "id": "tsk_...", "status": { "state": "submitted" } } }` --
or an immediate `rejected` task if the target slug is unknown/out of scope.

### Task updates (replaces SSE streaming)

Notification, sent by the task's server side as the task moves:

```json
{ "jsonrpc": "2.0", "method": "tasks/statusUpdate",
  "params": { "taskId": "tsk_...", "status": { "state": "completed" },
              "result": { "role": "agent", "parts": [{ "kind": "text", "text": "Done. 3 tests fixed." }] } } }
```

### `tasks/get`, `tasks/cancel`

A2A GetTask / CancelTask, unchanged shapes. Poll fallback + cancellation.

### `conversations/list` (extension, scope `list`)

Returns the peer-scoped address book: `[{ slug, title, project, state }]` -- ONLY
conversations the peer's project allowlist exposes. Never raw `conv_` ids, never the
full registry.

### `card/get`

Returns the A2A AgentCard (name, description, skills, capabilities). In-band
discovery after auth.

## 9. Task lifecycle mapping (CLAUDEWERK side)

| A2A state | Meaning here |
|---|---|
| `submitted` | Accepted, queued for the conversation (or awaiting LINK approval) |
| `working` | Conversation turn active |
| `input-required` | The conversation asked the peer a question back |
| `completed` | Conversation **settled** -- reuses the parent-notify settle machinery (idle + no background sub-agents for the settle window); result = the settled reply/status |
| `rejected` | LINK blocked, scope/allowlist miss, or rate-limited |
| `failed` | Conversation errored/died before settling |
| `canceled` | Peer sent `tasks/cancel` |

## 10. CLAUDEWERK implementation mapping

- **Inbound** `message/send` -> resolve slug via address book -> **LINK approval
  gate** (same first-contact banner as inter-session; peer link approvals persist in
  the peer registry, not in-memory) -> `channel_deliver` wrapped in
  `<channel source="gate" sender="peer" intent="...">` -- untrusted framing, rendered
  with the existing decoration.
- **Outbound**: a conversation's `send_message` to a `gate:*` slug routes to the
  bridge client instead of a local conversation. Reply task updates deliver back as
  channel messages.
- **New pieces**: `src/broker/bridge/` (channel server + dialer client + queue +
  registry), `bridge_peers` + `bridge_keys` + queue tables in the store, `broker-cli
  bridge` verbs (`add-peer`, `issue-key`, `revoke-key`, `status`), WS role
  `bridge-peer` in the message-router role table.
- **Naming**: this is the **BRIDGE**. It is NOT the existing `gateway` role
  (`gw_`, backend adapters/hermes) -- no reuse, no collision. Key prefix `brg_`.
- **Covenants apply**: every lifecycle event (peer connect/disconnect/supersede,
  grant proven, direction rejected, revocation, queue drain/expiry, task
  transitions) is a typed, persisted, rendered structured message with full context.

## 11. Security considerations

1. **Spend-bomb guard**: an inbound bridge message can wake an agent = real money.
   Per-key rate limit enforced server-side (default 10 msgs/min), project
   allowlist, LINK approval per conversation. All three before any agent wakes.
2. **Untrusted content**: peer text is data, never instructions -- `<channel>`
   framing end-to-end; no tool authority attaches to bridge traffic.
3. **Key hygiene**: hashed at rest on the issuer, shown once, CLI-mint only,
   greppable audit log lines (`[bridge] ...`) for every mint/proof/revoke/reject.
4. **No transitive reach**: v1 scopes are `mention` and `list`. No spawn, no kill,
   no file access, no sentinel verbs over the bridge.
5. **DoS**: 1 MiB frame cap, dedupe-store TTL, queue TTL + depth cap (default 1000;
   overflow rejects sends with `-32012 queue_full` rather than growing unbounded).

## 12. Prior art (why these choices)

- **A2A v1.0.0** -- data model, task lifecycle, agent cards, security-scheme
  declaration. Section 12 sanctions custom bindings.
- **LSP** -- the proof that symmetric JSON-RPC over one connection works at scale;
  "who dialed" stops mattering exactly as intended here.
- **MQTT** -- QoS-1 at-least-once + persistent sessions inspired section 7; rejected
  as the protocol itself (central broker topology, topic pub/sub, req/resp only
  bolted on in v5).
- **XMPP S2S dialback** -- the ancestor of per-direction grants; we get the same
  property on one socket via the hello key-proof instead of two TCP streams.
- **WAMP / STOMP / graphql-ws** -- surveyed for WS framing patterns; all bring
  router components or subscription semantics we do not need between two peers.
- **Plain signed webhooks** -- the boring runner-up; lost on push-over-channel,
  presence, and the task lifecycle it lacks.
