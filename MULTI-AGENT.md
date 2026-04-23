# Multi-Agent Architecture Research

Research doc for supporting multiple rclaude-sentinel instances (one per host/machine).

## Current Architecture (Single Agent)

### How it works now

- Agent connects via WS with `RCLAUDE_SECRET` as query param
- Sends `{ type: 'sentinel_identify' }` - no identity fields at all
- Concentrator stores it as a single `let agentSocket` variable
- Second sentinel gets `sentinel_reject` + close(4409), exits immediately
- Dashboard gets `{ type: 'sentinel_status', connected: boolean }` - single bool
- Revive sends to `sessionStore.getSentinel()` - there's only one, no routing needed

### What carries identity today

- `RCLAUDE_SECRET` - pure auth credential, no identity
- `wrapperId` (UUID) - per-rclaude-instance, identifies a PTY session, not a host
- `SessionMeta` - has cwd, model, capabilities, version, but no hostname/machineId
- Nothing in the protocol identifies which physical machine anything runs on

## Proposed Multi-Agent Design

### Option A: Multiple secrets (simplest)

Each host gets its own secret. The secret doubles as both auth and identity.

```
Host A: RCLAUDE_SECRET=secret-host-a
Host B: RCLAUDE_SECRET=secret-host-b
```

Concentrator config maps secrets to agent labels:

```json
{
  "agents": {
    "secret-host-a": { "label": "macbook", "hostname": "jonas-mbp" },
    "secret-host-b": { "label": "server", "hostname": "docker-host" }
  }
}
```

**Pros:** Zero protocol changes for auth. Simple config.\
**Cons:** Secrets become identity - awkward. Rotating a secret changes identity.

### Option B: Agent identity in protocol (recommended)

Agent sends identity on connect. Secret stays as shared auth.

```typescript
// Agent -> Concentrator
interface SentinelIdentify {
  type: 'sentinel_identify'
  hostname: string    // os.hostname() or --label flag
  machineId?: string  // optional stable ID (hardware UUID, etc.)
}
```

Concentrator stores agents in a map:

```typescript
// session-store.ts
const agentSockets = new Map<string, ServerWebSocket<unknown>>()
// key = hostname or machineId
```

**Pros:** Clean separation of auth vs identity. Easy to add fields later.\
**Cons:** Slightly more protocol work.

## Required Changes (Option B)

### Protocol (`protocol.ts`)

```typescript
// Add hostname to SentinelIdentify
interface SentinelIdentify {
  type: 'sentinel_identify'
  hostname: string
}

// SentinelStatus broadcast -> list of agents
interface SentinelStatus {
  type: 'sentinel_status'
  agents: Array<{ hostname: string; connected: boolean }>
}

// ReviveSession needs target routing
interface ReviveSession {
  type: 'revive'
  sessionId: string
  cwd: string
  wrapperId: string
  targetSentinel: string  // hostname of the sentinel that should handle this
}

// SpawnSession same
interface SpawnSession {
  type: 'spawn'
  requestId: string
  cwd: string
  wrapperId: string
  targetSentinel: string
}
```

### Session Store (`session-store.ts`)

- Replace `let agentSocket` with `Map<string, ServerWebSocket<unknown>>`
- `setSentinel(hostname, ws)` - allow multiple, keyed by hostname
- `getSentinel(hostname?)` - look up by key, or return first if unspecified
- `removeSentinel(ws)` - find by socket reference, remove from map
- `hasSentinel(hostname?)` - check specific or any

### Session -> Agent Routing

Sessions need to know which host they originated from:

```typescript
interface Session {
  // ... existing fields
  originHost?: string  // hostname of the sentinel that first connected this session
}
```

When a wrapper connects via `SessionMeta`, the concentrator records which agent
socket is on the same host (match by secret or by wrapper's declared hostname).

Revive routes to `session.originHost`. Spawn routes to user's selected target.

### Dashboard

- `sentinelConnected: boolean` -> `agents: Array<{ hostname: string; connected: boolean }>`
- Revive button: auto-selects the agent matching session's origin host
- Spawn UI: dropdown to pick target agent (if multiple connected)
- Agent status indicator: show count + list instead of single dot

### Agent Process (`src/sentinel/index.ts`)

- Add `--hostname <label>` flag (defaults to `os.hostname()`)
- Send hostname in `sentinel_identify`
- Remove `process.exit(1)` on reject (no more single-agent exclusivity)

## Migration Path

1. Add `hostname` to `SentinelIdentify` (backward compat: concentrator treats missing as "default")
2. Change session-store from single socket to Map
3. Add `originHost` to Session, set it when wrapper connects
4. Update dashboard `sentinelConnected` to `agents` array
5. Update revive/spawn routing to target specific agent
6. Update dashboard UI for multi-agent

Steps 1-3 can ship without breaking existing single-agent setups.

## Open Questions

- Should agents share a single `RCLAUDE_SECRET` or each have their own?
  Both work with Option B. Single secret = simpler ops. Multiple secrets =
  defense in depth (compromise one host doesn't auth another).
- How to handle a session that needs to revive but its origin agent is offline?
  Options: fail with clear error, offer to spawn on a different agent, queue
  the revive until the agent reconnects.
- Do we need agent-to-agent communication? (Probably not for v1.)
