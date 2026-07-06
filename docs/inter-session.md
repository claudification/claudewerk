# Inter-Session Communication

Sessions with `channel` capability discover and message each other through the broker.
All routing uses existing WS connections. Offline messages queued for reconnect delivery.

## MCP Tools

- `list_conversations` - discover conversations, returns address book slug as `id`
- `send_message` - send to slug (resolves via address book -> CWD -> session)

## Permission Gating

- First contact queues message, dashboard shows LINK approval banner (ALLOW/BLOCK)
- Claude NEVER sees the permission request (security)
- Block debounces 1 minute
- Allow is permanent for broker lifetime (not persisted across restarts)
- Links are bidirectional (approve A->B = approve B->A)
- Either side can sever via X button in session info

## Message Format

```xml
<channel source="rclaude" sender="session" from_session="abc123"
  from_project="wandershelf" intent="request" conversation_id="conv_xyz">
Can you run the integration tests?
</channel>
```

## Parent-notify report-back (EXPENSIVE opt-in)

A `spawn_conversation` may set `notifyParent: true` (with optional
`notifyParentSettleMs`, default 20000) to have the spawned CHILD report its
latest `set_status` back to its launching (PARENT) conversation once it
**settles**. Set it ONLY when you really rely on the child's output/completion --
each report costs the parent a wake/turn.

Flow (broker, `src/broker/parent-notify.ts`):

1. The child sets a status **or** ends a turn (goes `idle`) -> arm a settle timer.
2. The timer resets if the child continues (turn goes `active`) or a background
   sub-agent is running; it re-arms when the sub-agents drain and the turn is idle.
3. After the settle window of quiet, the broker delivers the child's latest
   `liveStatus` to `parentConversationId` as a `channel_deliver` (intent
   `notify`) plus a toast. The fire re-validates settled state and dedupes by
   `liveStatus.seq`, so an unchanged status never re-reports.

This is a SYSTEM report keyed on spawn lineage, so it **bypasses the link gate**
(the parent opted in at spawn time) and does **not** force-wake the parent's
agent loop -- the parent sees the message on its next turn (or queued if offline).

**Wiring:** the child row carries `notifyParentSettleMs` (persisted in `meta`,
survives broker restart); background sub-agent liveness rides a
`background_activity` wire signal emitted by the agent host on SubagentStart/Stop
(`ctx.runningSubagents`), stored transiently as `Conversation.backgroundBusy`.

**Limitation:** the background sub-agent gate is **headless-only** (the default
backend for agent-spawned conversations). The `claude-daemon` transport does not
emit `background_activity`, so for daemon children the settle relies on
idle/active churn alone (`backgroundBusy` stays 0). Wiring the daemon host's
sub-agent liveness is a follow-up.

## Dashboard Display

- Sidebar: `-> project1, project2` in teal for linked sessions
- Session info: linked sessions with X sever button
- Transcript: inter-session messages decorated with `{project} [{intent}]` label
- Link requests: teal LINK banner with ALLOW/BLOCK at top of session detail
