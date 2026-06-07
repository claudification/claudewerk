# Daemon Mode (the `claude-daemon` transport)

claudewerk drives the `claude` backend over three transports (the transport
reframe, `.claude/docs/plan-claude-transport-reframe.md`):

| Transport         | Wire mechanism                          | Default for          |
| ----------------- | --------------------------------------- | -------------------- |
| `claude-pty`      | terminal emulation (interactive)        | user-interactive (selectable) |
| `claude-headless` | stream-json over stdin/stdout           | (selectable)         |
| `claude-daemon`   | the cc-daemon control socket (attach + reply + subscribe) | **agent-spawned (default since Phase 8, 2026-05-23)** |

Daemon mode attaches to a background `claude` worker hosted by the Claude Code
supervisor daemon (`claude daemon`, 2.1.143+). The worker is billed against the
Anthropic **subscription pool**, not the API pool -- the strategic reason daemon
is now the default transport for agent-spawned conversations. The Phase 8
cutover (`defaultTransport.claude` = `claude-daemon` in
`src/broker/global-settings.ts`) governs agent-spawned launches (MCP
`spawn_conversation`, inter-conversation `channel_spawn`); the control-panel
spawn dialog always names a transport explicitly, so PTY and headless remain one
click away. The subscription-pool billing is re-verified against the 2026-06-15
billing reclassification (see the plan's Phase 8 release-gate).

The worker is owned by the daemon, not by claudewerk. claudewerk attaches to its
PTY (mirrored to the broker as `terminal_data`) and observes its state via the
daemon `subscribe` op. Because claudewerk does not own the process, some control
surfaces that PTY/headless get "for free" are reduced. **This document is the
honest, live-verified inventory of what works, what is reduced, and why.**

## Control surface: what works, what is reduced

Verdicts are LIVE-VERIFIED against CC 2.1.150 (transport-reframe Phase 7 spikes,
2026-05-23). Where a hypothesis from the original inventory was wrong, the spike
result is authoritative and noted. The permission + streaming rows were
re-verified against CC 2.1.168 (2026-06-07) -- see those rows for the corrected
findings.

| Feature                                   | Daemon-mode verdict | Notes |
| ----------------------------------------- | ------------------- | ----- |
| **Model switching** (`set_model`)         | **PARITY (live)**   | `/model <name>` via the daemon `reply` op rotates the model on the next turn (spike 3b, confirmed haiku -> sonnet). Wired as the `set_model` control verb. |
| **Interrupt** (`interrupt`)               | **PARITY**          | Ctrl+C (`\x03`) into the worker PTY via the attach handle. |
| **Conversation status**                   | **UPLIFT**          | The daemon `subscribe` stream exposes the worker's own run-state (`working`/`blocked`/`done`/...) + a human-readable `detail` ("running echo SPIKE_OK"). claudewerk mirrors it as `conversation_status` + `daemon_state_patch` instead of scraping the PTY. Richer than PTY/headless. |
| **`/clear`**                              | PARITY              | Wired in the daemon-agent-host (session-observer detects the rotation). |
| **Hook output / MCP channel / transcript continuity / subagent transcripts** | PARITY | The worker IS `claude`; its transcript JSONL + tool vocabulary are identical. Config (`--settings`/`--mcp-config`/`--append-system-prompt`) is injected at dispatch (transport-reframe Phase 2). |
| **respawn-stale**                         | **UPLIFT**          | Native daemon recovery for the sleep/wake `failed` case (the `respawn-stale` op), surfaced as a control verb. PTY/headless have no equivalent. |
| **Effort level** (`set_effort`)           | **REGRESSION (recorded-for-respawn)** | `/effort` is NOT a CC slash command; effort is the `CLAUDE_CODE_EFFORT_LEVEL` env var read at **process start** (spike 3a: a live `reply('/effort high')` is a no-op). claudewerk records the requested level (`effort_changed`, `appliedVia: 'next_dispatch'`) and surfaces a toast; **it takes effect on the next worker (re)spawn, not the current turn.** Headless mode applies effort live via `update_environment_variables`; daemon mode cannot. |
| **`update_environment_variables`** (live env mutation) | REGRESSION | A running daemon worker's env is fixed at dispatch. Env changes (including effort) apply only on the next (re)spawn. |
| **`set_permission_mode`** (live)          | REGRESSION          | A running daemon worker's permission mode is fixed at dispatch. Not live-controllable; the daemon-agent-host logs the unsupported verb rather than pretending. |
| **Tool-use permission gates** (`permission_request`) | REDUCED (free-text reply) | **Re-verified 2.1.168 (2026-06-07).** A `source:'fleet'` worker DOES gate: a Write to `/etc` surfaced `state:'blocked'` + a human `needs` string + `detail`, cleanly observable via `subscribe` (`daemon_block_observed` -> the panel's amber `Waiting` banner). What does NOT fire is CC's numbered 1/2/3 tool-permission menu -- the gate is a *conversational* question answered by a **FREE-TEXT `reply`** typed into the chat box (the `input` path), NOT an allow/deny choice. The dedicated daemon `permission-response` op is **DEAD**: its required `requestId` correlator is never surfaced in the JobRecord, so no candidate request shape ever ACKs (re-confirmed 2.1.168). The old allow/deny -> `reply('1'\|'2'\|'3')` mapping was removed (2026-06-07) -- a bare menu number reads as an unrelated instruction and confuses the worker (live-verified). |
| **AskUserQuestion approvals**             | **MAJOR REGRESSION** | Daemon spare-pool workers did not surface `state:'blocked'` for AskUserQuestion in the Phase 7 spikes (3e). An AskUserQuestion gate inside a daemon worker is not reliably observable as a structured block, and the `updatedInput` round-trip is lossy. **If a workflow depends on AskUserQuestion approvals, use PTY mode.** |
| **`/permissions` picker**                 | REGRESSION (PTY-attach only) | `reply('/permissions')` is accepted by the daemon but surfaces no structured handle (spike 3c). The picker renders in the PTY; driving it requires raw keystroke navigation through the attach (`terminal_data`) -- fragile, no typed verb. |
| **Exact `total_cost_usd` per turn**       | REGRESSION (estimated) | Headless reports exact per-turn cost; daemon cost is estimated from tokens + LiteLLM pricing. Moot in practice -- daemon workers are subscription-billed, not API-billed. |
| **`rate_limit_status`**                   | REGRESSION (coarser) | Profile-scoped, coarser than the headless `rate_limit_event`. |
| **Partial-message streaming**             | REGRESSION (permanent) | Headless gives token-by-token `stream_delta`s. Daemon mode has **no structured partial-message source**: the JSONL transcript holds complete turns only, and both `subscribe` (`stream` frames) and `attach` carry raw PTY/ANSI bytes. Token-by-token output is visible in the **web terminal** (raw PTY); the structured transcript renderer receives the final entry per turn from the JSONL. Closing this would require fragile ANSI reconstruction -- **accepted as a permanent daemon limitation** (2026-06-07), same class as live effort/env. |
| **Plan Mode**                             | REGRESSION (lossy round-trip) | Same lossy round-trip as AskUserQuestion. |
| **OSC 52 clipboard / slash-command autocomplete** | PARITY | Same PTY byte stream / JSONL `system/init`. |

## Practical guidance

- **Default to daemon for autonomous / agent-spawned work** (subscription
  billing, survives the agent-host crash, native respawn-stale, richer status).
- **Ordinary tool-permission gates DO work in daemon mode.** A blocked worker
  shows an amber `Waiting` banner with its `needs` question; answer it by typing
  a normal (free-text) reply in the chat box -- there is no allow/deny button
  because the daemon surfaces a conversational gate, not CC's numbered menu.
- **Use PTY for the structured-approval UIs** -- AskUserQuestion and Plan Mode
  round-trips are lossy over daemon, and the `/permissions` picker has no typed
  handle. These remain the documented daemon-mode regressions.
- **Effort is a launch-time setting in daemon mode.** Set it when you spawn (it
  rides the worker env); a mid-conversation `set_effort` is queued for the next
  (re)spawn, not applied to the current turn. The control panel toast says so.
- **Model can be switched live** in daemon mode (`set_model`); it takes effect
  on the next turn.

## How claudewerk observes a daemon worker

```
daemon worker PTY  --attach-->  daemon-agent-host  --terminal_data-->  broker --> web terminal
daemon worker state --subscribe-->  status-mirror  --daemon_state_patch / conversation_status / daemon_block_observed--> broker --> control panel
control verbs (set_model / set_effort / interrupt / reply / kill / respawn-stale) --> daemon-agent-host --> cc-daemon ops
```

The `subscribe` state-patch shape (live-confirmed): a partial `JobRecord` with
`state` (`running`/`working`/`blocked`/`resuming`/`failed`/`done`/`crashed`),
`tempo` (`active`/`idle`), `detail` (human-readable), and `needs` (the
"what's blocking" string, usually empty). See
`.claude/docs/cc-daemon-control-protocol.md` § 5.5 for the wire shapes and
`.claude/docs/plan-claude-transport-reframe.md` for the reframe design.
