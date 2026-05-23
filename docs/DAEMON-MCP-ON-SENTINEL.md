# MCP at the Sentinel -- Architecture for Daemon-Backend Workers

**Status:** PROPOSAL (2026-05-23)\
**Owner:** Jonas\
**Scope:** Design the MCP surface for daemon-backed `claude` workers. Companion
to `plan-daemon-launch-ux.md` (now SHIPPED) and to the in-flight
`claude-transport-reframe` worktree (which reframes "daemon" as a transport of
the `claude` backend rather than its own backend).

The current PTY-mode MCP server lives inside `claude-agent-host` and binds a
local port that the worker reaches via `127.0.0.1` (see
`src/claude-agent-host/mcp-channel.ts:211`-`243`). That model does not survive
the daemon split:

- The worker is owned by `claude daemon`, not by the agent host. It outlives
  `daemon-agent-host` re-attaches (`src/daemon-agent-host/index.ts:301`-`329`).
- The daemon may live on a different host than the broker. The control panel
  reaches the worker via the broker WS; the worker reaches MCP via a local URL
  written into `--mcp-config` at `claude --bg` time
  (`src/sentinel/daemon-dispatch.ts:80`,
  `src/sentinel/index.ts:2918`-`2937`). That URL must stay valid across
  daemon-agent-host restarts because the daemon never re-reads
  `--mcp-config` -- the worker's mcp-config is frozen at fork time.

So the worker's MCP endpoint must be anchored to something at least as
long-lived as the worker itself. That rules out `daemon-agent-host`. The
candidate anchors are the **sentinel process** (host-local, long-lived) or the
**broker** (remote, even longer-lived but lossy on latency / channel push). We
land on a split: sentinel-anchored MCP proxy for channel features, direct-to-
broker MCP for stateless tools.

---

## 1. The two MCP surface classes

The current PTY MCP server (`src/claude-agent-host/mcp-channel.ts`) does TWO
things, and conflating them is what blocks a clean daemon design:

| Surface | Examples | Wire shape | Latency-sensitive | Conversation-scoped |
|---|---|---|---|---|
| **Channel surface** | `notifications/claude/channel` push (`mcp-channel.ts:266`-`291`), `permission_request` notifications (`mcp-channel.ts:192`-`209`), `permission_response` (`mcp-channel.ts:305`-`322`), dialog reply delivery | SSE stream, server-pushed | YES (interactive) | YES (one stream per conversation) |
| **Tool surface** | `notify`, `send_message`, `spawn_conversation`, `list_conversations`, `search_transcripts`, `get_transcript_context`, `project_list`, `project_set_status`, `share_file`, `recap_*`, `dialog`, `whoami` | HTTP request/response | NO (one-shot calls) | NO (cross-conversation by design) |

The broker already serves the tool surface to non-CC clients at `/mcp`
(`src/broker/routes/mcp-server.ts:332`-`373`). It is bearer-auth, stateless,
JSON-response (no SSE). Reusing it for daemon workers is mostly a matter of
authentication.

The channel surface is the harder problem: it needs an SSE-capable endpoint
that routes to a specific conversation's bridge process. That endpoint cannot
be the broker (too lossy, channel pushes shouldn't have to traverse the WAN
twice), and cannot be `daemon-agent-host` (it dies and re-spawns under the
worker).

---

## 2. Recommended architecture: one MCP proxy per sentinel

```
   ┌──────────────────────── sentinel host ────────────────────────┐
   │                                                                │
   │   sentinel process (long-lived)                                │
   │   ├─ src/sentinel/index.ts                                     │
   │   └─ src/sentinel/mcp-proxy.ts  (NEW)                          │
   │      ├─ listens on a Unix socket: /tmp/claudwerk-mcp-<uid>/    │
   │      │   sentinel.sock  (fallback: 127.0.0.1:<port>)           │
   │      ├─ HTTP server: Streamable HTTP MCP transport             │
   │      ├─ routes /mcp/<conversationId>  -> per-conv handler      │
   │      ├─ validates bearer token against in-memory conv table    │
   │      └─ holds a small NDJSON buffer per conversation for SSE   │
   │           replay across daemon-agent-host churn                │
   │                                                                │
   │   daemon-agent-host (per conversation, ephemeral)              │
   │   ├─ src/daemon-agent-host/index.ts                            │
   │   ├─ on boot: registers with the sentinel mcp-proxy via a      │
   │   │   local control socket  (claim conversationId + secret)    │
   │   ├─ subscribes to the proxy's channel stream for its conv     │
   │   └─ forwards broker -> worker channel pushes through the      │
   │       proxy's SSE (so the worker sees them as MCP              │
   │       notifications/claude/channel)                            │
   │                                                                │
   │   claude daemon (CC-owned)                                     │
   │   └─ worker PTY  (--mcp-config baked at --bg time)             │
   │       claude:  http://127.0.0.1:<port>/mcp/<conversationId>    │
   │            or: unix:/tmp/claudwerk-mcp-<uid>/sentinel.sock     │
   │                Authorization: Bearer <per-conv-token>          │
   │                                                                │
   └────────────────────────────────────────────────────────────────┘
                │
                │  (broker-state tools go directly to the broker)
                ▼
   ┌──────────────────────────────────────────────────────────────┐
   │   broker:  https://concentrator.frst.dev/mcp                 │
   │   already served by src/broker/routes/mcp-server.ts          │
   │   bearer auth: per-conversation MCP token (NOT the sentinel  │
   │   shared secret)                                             │
   └──────────────────────────────────────────────────────────────┘
```

### 2.1 Why one proxy per sentinel, not one per conversation

Per-conversation MCP servers (the current PTY-mode model) bind a fresh port
per spawn. For daemon workers that breaks three ways:

1. **`--mcp-config` is frozen at `claude --bg` time.** The daemon never
   re-reads the config. A new port on re-attach means the worker keeps trying
   the old (dead) port forever.
2. **The bridge process is the wrong anchor.** `daemon-agent-host` is killed
   and respawned by the sentinel on its own schedule (worker outlives bridge,
   bridge dies on socket drop and the next attach is a fresh PID). A port
   bound by a dead process is gone; the next bridge cannot bind the same port
   without coordination.
3. **No replay across bridge churn.** Channel pushes that arrived while no
   bridge was attached are lost. We want at-least-once semantics for
   `notifications/claude/channel` and `permission_request`.

Per-sentinel MCP proxy solves all three:

- Sentinel's lifetime >> worker's lifetime >> bridge's lifetime. The proxy is
  the right anchor.
- One stable address (Unix socket preferred -- no port allocation race, no
  conflict with user-bound ports). Workers spawned by different conversations
  multiplex via the URL path (`/mcp/<conversationId>`) and the bearer token.
- A small ring buffer per conversation (say, last 64 channel pushes + every
  outstanding `permission_request`) replayed on bridge re-attach. The bridge
  pulls from the proxy, the proxy pulls from the broker WS via the bridge.

### 2.2 Why this is also better than per-broker MCP for the channel surface

A broker-hosted channel SSE would force every keystroke-equivalent (channel
push, permission decision) over the WAN twice (control panel -> broker WS,
broker -> worker SSE). The worker is on the sentinel host; staying local for
channel events is a measurable latency win and removes a single point of
broker failure for in-conversation UX. Broker-state tools are different --
they're one-shot RPCs that already pay the WAN round-trip; routing them
through a local proxy would be pure overhead.

### 2.3 Trade-offs

- One more long-lived listener per sentinel host. Mitigation: Unix socket, no
  externally-routable surface, uid-locked just like `cc-daemon`'s own socket
  dir (`/tmp/cc-daemon-<uid>/<8hex>/`).
- The proxy must understand the MCP protocol enough to multiplex
  conversations. Mitigation: reuse the same `@modelcontextprotocol/sdk` we
  already use in `mcp-channel.ts:20`-`21` and `routes/mcp-server.ts:9`-`10`.
  The proxy is a thin router; per-conversation MCP server instances live
  inside it, one `McpServer` per active conversation, swapped out on
  conversation_end.
- Cross-host workers (a future sentinel running on a different machine than
  the broker) still benefit because the worker is always co-located with the
  sentinel that minted its mcp-config.

---

## 3. Tool routing: who handles what

This is the answer to "which broker-state tools should the worker reach
directly via the broker vs. via the sentinel proxy."

### 3.1 Direct to the broker (`https://<broker>/mcp`)

All stateless, cross-conversation, latency-tolerant tools currently registered
in `src/broker/routes/mcp-server.ts`:

- `notify` (line 29) -- one-shot push, no streaming
- `search_transcripts` (line 73) -- broker is the source of truth
- `get_transcript_context` (line 119) -- same
- `send_message` (line 138) -- broker is the routing point anyway
- `spawn_conversation` (line 196) -- broker dispatches spawns
- `list_conversations` (line 264) -- broker holds the registry
- `project_list` / `project_set_status` (lines 295, 308) -- KV store in broker
- Future additions: `share_file`, `whoami`, `list_hosts`, `recap_*`

These NEVER need to know about the sentinel. Routing them through the proxy
would be a worthless extra hop. The worker sends an HTTPS request, the broker
answers. Auth is a per-conversation bearer token (see section 4).

Latency cost (representative): 30-80ms WAN round-trip, equal to the cost a
PTY-mode worker pays today when these tools cross the WS. No regression.

### 3.2 Through the sentinel proxy (`unix:/tmp/.../sentinel.sock`)

Anything channel-shaped or requiring server-pushed notifications to the
worker:

- `notifications/claude/channel` push (the dashboard-typed input that lands as
  `<channel sender="dashboard">` in the worker context)
- `notifications/claude/channel/permission_request` push (server -> worker)
- `notifications/claude/channel/permission` response (worker -> server -> broker)
- Local-only tools the broker has no business arbitrating: `dialog` (interactive
  approval prompts), `keepalive_dialog`, `resolve_dialog`. These currently live
  on `mcp-channel.ts` and conceptually belong to the agent-host process.

A pragmatic split: every existing tool in `src/claude-agent-host/mcp-tools/`
falls into one of two buckets:

- **Pure RPC** (`notify`, `send_message`, `spawn_conversation`,
  `list_conversations`, `search_transcripts`, `project_*`,
  `share_file`, `recap_*`, `list_hosts`, `whoami`) -> broker `/mcp` directly.
- **Channel-coupled** (`dialog`, conversation-identity tools that need the
  agent-host's local `getIdentity()`) -> sentinel proxy.

A worker's frozen `--mcp-config` therefore carries **two** MCP servers:

```json
{
  "mcpServers": {
    "claudwerk": {
      "type": "http",
      "url": "https://concentrator.frst.dev/mcp",
      "headers": { "Authorization": "Bearer <per-conv-broker-token>" }
    },
    "claudwerk-local": {
      "type": "http",
      "url": "http+unix:///tmp/claudwerk-mcp-501/sentinel.sock:/mcp/<conversationId>",
      "headers": { "Authorization": "Bearer <per-conv-proxy-token>" }
    }
  }
}
```

(Implementation note: if `claude` cannot speak `http+unix`, fall back to
`http://127.0.0.1:<port>/mcp/<conversationId>` with the port stored in
`~/.claudwerk-sentinel/state.json` for `--mcp-config` regeneration. Unix
socket is the preferred path; the loopback port is a compatibility shim.)

### 3.3 Security trade-off

- Direct-to-broker means the worker holds a broker-trusted credential. If the
  worker is compromised, the attacker can call `spawn_conversation`,
  `send_message`, etc., with the user's identity. Mitigation: scope the
  per-conversation token to a small role (see section 4.3).
- Proxy-mediated means the worker only ever speaks to a local Unix socket.
  Compromise gives the attacker channel pushes / dialog replies but not the
  cross-conversation surface. The proxy can rate-limit, audit, redact.
- Net: prefer the proxy when it doesn't cost latency; prefer direct when it
  would. The split above falls out of that principle.

---

## 4. Per-conversation auth tokens

The current model is one broker secret per sentinel
(`CLAUDWERK_SENTINEL_SECRET`, e.g. `src/sentinel/index.ts:1252`), reused for
the agent host's broker WS (`src/sentinel/index.ts:570`). That's wrong for the
daemon model: the worker outlives the bridge, and a worker holding the
sentinel's shared secret is a much bigger blast radius than necessary.

### 4.1 Minting

The broker mints a per-conversation MCP token at spawn dispatch
(`src/broker/spawn-dispatch.ts`). The token is `mcp_` + `nanoid(32)`, recorded
in the conversation registry alongside `agentHostMeta`, never logged in full.
Two tokens are minted: one for direct-broker MCP, one for sentinel-proxy MCP.
They are independent so a sentinel compromise doesn't grant broker MCP access
and vice versa.

The broker token is opaque; `resolveAuth` in `src/broker/auth-routes.ts`
(referenced from `routes/mcp-server.ts:353`) needs a new role for it -- call
it `mcp-conversation` -- mapped to a permission set scoped to the
conversation that minted it.

The proxy token is opaque to the broker too; the broker passes both tokens to
the sentinel in the spawn message, the sentinel writes them into the
`--mcp-config` file, the sentinel records the proxy token in its in-memory
conversation table, the worker holds them via the frozen `--mcp-config`.

### 4.2 Distribution

Three candidates were considered:

| Mechanism | Pros | Cons | Verdict |
|---|---|---|---|
| **Env var** (`CLAUDWERK_MCP_TOKEN`) | trivial to plumb | leaks via `/proc/<pid>/environ` to any same-uid process, persists in the daemon's `JobRecord` after the worker exits, hard to rotate without restart | NO |
| **cwd-local file** (`.claudwerk/mcp-token`) | survives bridge restarts | the worker's cwd may not be writable, ends up in `git status` noise, easy to commit by accident | NO |
| **`--mcp-config` JSON, sentinel-owned tmpfile** | already in use for daemon worker config injection (`src/sentinel/daemon-dispatch.ts:80`), file-perm-locked (0o600), unlinkable on revoke, never on `argv` past the fork | requires `--mcp-config` to point at a stable path and the file to stick around (the daemon worker reads it at fork) | **YES** |

The sentinel writes `/tmp/claudwerk-mcp-<uid>/conv-<conversationId>.json` mode
0o600, passes its path via `--mcp-config`, and unlinks it on
`conversation_end`. The worker (a child of the daemon, NOT the sentinel) has
the config in its memory after fork, so even if the file vanishes the worker
is fine until the next `claude --bg`. RESUME and ATTACH both inherit the same
config path (ATTACH skips the mcp-config write entirely since the worker is
already configured -- see `plan-daemon-launch-ux.md` section 0).

### 4.3 Token scope (attack surface limits)

The `mcp-conversation` role bound to a per-conversation token is allowed to:

- Call any tool registered on the broker MCP, BUT
- `send_message` only TO conversations the caller has been linked to (the
  existing link-approval flow in `docs/inter-session.md`).
- `spawn_conversation` only with `callerProject` = the caller's project. The
  current `dispatchSpawn` callerContext (`routes/mcp-server.ts:224`-`235`)
  uses `callerProject: null`; for per-conv tokens it must be set to the
  caller's project URI.
- `list_conversations` returns only conversations the caller can read.
  Server-side permission filter already exists for the WS subscriber path;
  the per-conv token path needs the same filter applied to the result list.
- All tool calls are audit-logged with `conversationId` from the token,
  separating "calls from inside conv X" from "calls from an external client
  holding the same token" (the latter only happens if the token leaks, which
  is the audit signal).

This is a meaningful improvement on the current `mcp__rclaude__*` surface,
which today trusts any holder of `RCLAUDE_SECRET` to act as anyone.

### 4.4 Lifetime

- **Broker token:** lives until `conversation_end`. Stored in
  `conversation.agentHostMeta` (opaque to the broker by the Boundary Rule,
  but the broker's auth resolver maintains a parallel non-opaque map keyed by
  `conversationId`). Revoked on conversation end, on explicit
  `terminate_conversation`, or on operator action via `/api/sentinels/`
  rotate endpoint (new endpoint, scoped to one conversation or one sentinel).
- **Proxy token:** same lifetime, simpler revocation -- the sentinel proxy
  drops the in-memory entry and the next call 401s.
- **Worker outliving bridge:** both tokens stay valid. Bridge restart doesn't
  cycle tokens.
- **Worker outliving sentinel restart:** the sentinel must persist its
  per-conversation token table across restart (it already persists
  `claudewerk-daemon-map.json` at `src/sentinel/daemon-roster.ts`, same
  pattern). Tokens are durable on disk in the sentinel's data dir, mode
  0o600. On sentinel restart the proxy rehydrates from disk before listening.
- **Worker outliving broker outage:** broker tokens are validated on the
  broker side, so an outage breaks broker-state tools (the worker sees HTTP
  errors). Proxy-mediated tools keep working. The worker should treat broker
  MCP failures as transient and retry; mid-tool calls return errors rather
  than hanging because the broker MCP is stateless JSON-response.

### 4.5 Rotation

Three rotation triggers were considered:

1. **`/clear` (ccSessionId rotation):** NO. ConversationId is stable across
   `/clear` (IDENTITY MODEL covenant; `cc-daemon-control-protocol.md` notes
   that `JobRecord.sessionId` never rotates inside the daemon, the rotation
   is observed via the transcript directory only). The token is keyed by
   `conversationId`, so `/clear` is invisible to the token.
2. **Worker respawn (`respawn-stale`):** depends. If respawn keeps the same
   `conversationId` (the typical case -- ATTACH-style respawn keeps the
   conversation identity), token stays. If respawn implicitly ends the
   conversation and starts a new one, the token is for the new conversation
   and is independent.
3. **Daemon restart:** the daemon doesn't know about the token; it's
   embedded in the worker's `--mcp-config`. Daemon restart kills all workers
   anyway, so all tokens get revoked on `conversation_end` cascade. New
   workers get fresh tokens at the next `claude --bg`.
4. **Manual rotation:** `/api/sentinels/<id>/rotate-token?conversationId=...`
   admin endpoint. On rotation, the broker revokes the old token, the
   sentinel writes a new `--mcp-config` to the per-conversation tmpfile,
   and the worker is sent a `mcp_reload` channel notification. The worker
   itself cannot re-read `--mcp-config`, so the practical effect is "next
   `claude --bg` picks up the new token, but the running worker is stuck on
   the old one until it exits." Acceptable -- rotation is a security
   recovery path, not a routine operation.

Outcome: tokens are NOT auto-rotated on lifecycle events. They are bound to
the `conversationId` and live as long as the conversation.

---

## 5. Worker outliving its host -- what happens

This is the daemon-specific failure mode the design must handle. The scenario:
a daemon worker is alive (PTY held by `claude daemon`); the
`daemon-agent-host` bridge crashes or is reaped; the sentinel respawns the
bridge.

### 5.1 MCP server

The sentinel MCP proxy is independent of the bridge. It does NOT die when the
bridge dies. The worker's MCP calls (tool RPCs over Unix socket) continue to
land; they're routed by `conversationId` from the URL path, the proxy holds
its in-memory conversation table.

What CHANGES when the bridge dies:

- Channel push delivery (`notifications/claude/channel`) pauses, because the
  proxy's source-of-truth for "what the dashboard typed" is the bridge's WS
  to the broker. The bridge is dead -> no new pushes arrive at the proxy.
- The proxy keeps any unsent pushes in its ring buffer (broker-side, the
  dashboard's typing is already buffered by the conversation_store; we just
  need to not lose pushes that DID make it to the proxy before the bridge
  died, which the ring buffer covers).
- When the bridge re-attaches (`daemon-agent-host/index.ts:316`-`329`
  `reattachAfterDrop`), it re-registers with the proxy and asks for "send me
  channel pushes since seq N." Proxy replays. Worker sees the same channel
  push it would have seen if the bridge had never died.

### 5.2 Auth tokens

Tokens are NOT rotated on bridge restart. The worker's `--mcp-config` was
frozen at `--bg` time; the bridge has no authority to change it. Bridge
restart is invisible at the auth layer.

### 5.3 In-flight tool calls

Two sub-cases:

- **Broker-state tool calls (direct to broker /mcp):** Unaffected. Bridge is
  not in the path. The worker's HTTP call to the broker completes (or fails
  on its own merits) regardless of bridge state.
- **Sentinel-proxy tool calls:** Two flavors:
  - **Pure RPC** (e.g. `dialog`): the worker's HTTP request is in flight to
    the proxy. The proxy handles it independently of the bridge. For a
    `dialog` that needs a user response, the proxy publishes the
    dialog-request to the broker via a separate path (the proxy maintains its
    own broker WS, or the bridge proxies it when alive). If the bridge is
    dead, the dialog request is queued and resent on bridge re-attach.
  - **Channel notifications** (e.g. `permission_request` from worker -> proxy
    -> broker -> dashboard): same story, queued on the proxy and forwarded
    when a bridge is attached.

In all three cases the worker observes either (a) success, (b) a clean error
(broker unreachable), or (c) longer-than-usual latency (queued through bridge
re-attach). It never sees a half-completed tool call.

---

## 6. Implementation phases (sketch)

This doc is research; the build sequence below is a starting point, not a
commitment.

| Phase | Scope | Files touched |
|---|---|---|
| 1 | Per-conversation broker MCP token in `resolveAuth`. New `mcp-conversation` role. Scope filters for `send_message`, `spawn_conversation`, `list_conversations`. | `src/broker/auth-routes.ts`, `src/broker/routes/mcp-server.ts`, `src/broker/spawn-dispatch.ts` |
| 2 | Sentinel MCP proxy (new module). Listens on Unix socket, multiplexes `/mcp/<conversationId>`, persists token table. | `src/sentinel/mcp-proxy.ts` (NEW), `src/sentinel/index.ts` (wire-up), shared state file in sentinel data dir |
| 3 | Daemon worker `--mcp-config` writer. Two-server config (broker + sentinel-local), tmpfile lifecycle, ATTACH-aware. | `src/sentinel/daemon-dispatch.ts`, `src/sentinel/index.ts:2918`-`2937` |
| 4 | Bridge <-> proxy registration protocol. Bridge tells proxy "I own conversation X now," subscribes to channel push stream with seq cursor. | `src/daemon-agent-host/broker-bridge.ts`, `src/sentinel/mcp-proxy.ts` |
| 5 | Migrate `dialog` + channel push handlers off `mcp-channel.ts` into the proxy. PTY-mode keeps its current channel server unchanged for now (it's not broken). | `src/claude-agent-host/mcp-tools/dialog.ts`, `src/sentinel/mcp-proxy.ts` |
| 6 | Tier-2 live smoke harness extension: cover token rotation, bridge re-attach with queued channel pushes, broker outage tolerance. | `scripts/cc-daemon-launch-smoke.ts` |

PTY-mode `claude-agent-host` keeps its current `mcp-channel.ts` server until
phase 5 stabilises. Both models coexist; the broker auth resolver tells which
class of token it's seeing.

---

## 7. Decisions captured

1. **One MCP proxy per sentinel.** Not per conversation, not per bridge. The
   sentinel is the right anchor for an endpoint whose URL is frozen into the
   worker's `--mcp-config` at fork time.
2. **Two MCP servers in every daemon worker's `--mcp-config`.** Broker
   `/mcp` for stateless tools, sentinel-local proxy for channel-coupled
   tools.
3. **Per-conversation tokens, two of them.** One broker-trusted, one
   proxy-trusted. Minted at spawn, distributed via `--mcp-config` tmpfile
   mode 0o600, lifetime = until `conversation_end`. Not rotated on `/clear`,
   not rotated on worker respawn that preserves `conversationId`, not
   rotated on daemon restart.
4. **Prefer Unix socket** for the sentinel proxy (uid-locked, no port
   contention). Fall back to `127.0.0.1:<port>` only if the MCP SDK in
   `claude` can't speak `http+unix`.
5. **Replay buffer in the proxy** so bridge churn never loses channel
   pushes. Bridge re-attach uses a seq cursor.
6. **PTY-mode is unchanged** until the daemon backend is stable. We don't
   migrate the existing `mcp-channel.ts` until phase 5.

---

## 8. Open Questions for Jonas

1. **Does the bundled `claude` understand `http+unix` URLs in
   `--mcp-config`?** If not, the proxy needs a `127.0.0.1` port and we pay
   port-allocation discipline. Quick check: write a one-entry `--mcp-config`
   pointing at a Unix socket, see how `claude --bg` reacts. Worth doing
   before phase 2.
2. **Should the broker MCP per-conversation token be the same opaque value
   as the existing `agentHostMeta.brokerToken` if one exists, or a strictly
   separate token?** Separation simplifies revocation but doubles the
   mint/store cost. Lean toward separation; want a yes/no.
3. **`claude-transport-reframe` worktree implications.** If daemon becomes a
   transport of the claude backend rather than its own backend, the
   "sentinel proxy" name should stay but the `agentHostType:'daemon'`
   signal might disappear from the wire. The proxy logic shouldn't care
   either way -- it routes by `conversationId`, not by backend kind -- but
   the spawn-dispatch path needs alignment with whatever the reframe lands.
   Need to read the reframe plan before phase 1.
4. **Rate limiting / quotas.** The broker MCP is currently un-rate-limited
   (it trusts holders of `RCLAUDE_SECRET`). Per-conv tokens make per-conv
   quotas tractable. What's the policy? Tokens-per-minute? Tool-calls-per-
   minute? Per-tool budgets? Not blocking phase 1 but should be designed
   alongside the auth resolver work.
5. **`list_hosts` and cross-host visibility.** A worker on sentinel A asks
   `list_hosts`; should it see sentinel B's profile inventory or only its
   own? Today the broker tells everything; with per-conv tokens we can
   tighten this. Policy call.
