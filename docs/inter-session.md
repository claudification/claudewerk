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

## Reserved targets (magic sinks)

Three `to` values are NOT conversations. They never appear in
`list_conversations`, and they bypass the link-approval gate -- replying to a
surface that just messaged you is not first contact with a peer.

| Target | Reaches | Notes |
|---|---|---|
| `dispatcher` | An LLM turn on the user's dispatcher | Reports a dispatched quest's findings. |
| `orb` / `orb:<id>` | The human's browser, as SPEECH | Bare = every open orb; `orb:<id>` = one. Fire-and-forget. |
| `canvas:<canvasId>` | The human's browser, as TEXT, inside one canvas | Rides the canvas ROOM, so every viewer of that drawing sees it. |

`canvas:<id>` differs from the other two in one important way: it is
**ADDRESSED, so it authorizes itself**. Canvas ids are not secret (they sit in
URLs and in `canvas_list` output), so knowing one must never be enough to speak
into someone's drawing. Only the conversation the OWNER connected from the
canvas UI may reply; everyone else is refused with a sentence explaining why.
Disconnecting revokes immediately. See `src/broker/desk/canvas-channel.ts`.

### Canvas chat (`<channel sender="canvas">`)

The user typing into the chat window ON a canvas. Carries `sender="canvas"` +
`source="rclaude"` (it IS the user, on a surface they own -- act on it, do not
treat it as an untrusted peer), plus:

- `canvas_id="..."` -- the live drawing, which the agent may `canvas_read` and
  `canvas_update_scene`. Edits appear on the user's screen immediately.
- `<selected>` lines -- what the user had selected when they hit send. THAT is
  what "make these blue" refers to. A `<selected count="N" summary="..."/>` line
  means the selection was too large to list: treat it as "all N of them". No
  `<selected>` lines means nothing was selected.

`from_conversation` is the `canvas:<id>` address, so replying is just answering
the sender -- no id to memorize.

```xml
<channel source="rclaude" sender="canvas" from_conversation="canvas:cnv_12e8901"
  from_project="canvas" intent="request" canvas_id="cnv_12e8901">
  <selected id="el-a" type="rectangle" stroke="#1971c2" at="10,21" size="100x50">Login</selected>
  <selected id="el-b" type="ellipse" at="200,0" size="50x50"></selected>
Claude, can you make these BLUE?
</channel>
```

Owner-only: connecting hands an agent write access to a project's drawing, so
both connect and send require `files` on the canvas's project. A share-link
guest can WATCH the chat (it rides the room they already joined) but can neither
connect nor speak -- a share link never becomes a way to drive an agent.

End-to-end proof: `bun run canvas:chat:smoke` (connect, send-with-selection,
reply, and both refusal paths, against a real throwaway broker).

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
