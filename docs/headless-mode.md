# Headless Mode & MCP Channel

> **See also:** `docs/daemon-mode.md` -- the third claude transport
> (`claude-daemon`), its subscription billing, and the live-verified control
> surface (what works, what is reduced vs headless/PTY, and why).

## Headless Mode (stream-json backend)

`rclaude --headless` or `RCLAUDE_HEADLESS=1` uses Claude's `--print` mode with
structured NDJSON I/O instead of PTY. Explicitly selectable; since the Phase 8
transport-reframe cutover (2026-05-23) the default for agent-spawned sessions is
the `claude-daemon` transport (see `docs/daemon-mode.md`).

**Protocol reference:** `docs/stream-json-protocol.md` (879 lines, reverse-engineered)

```
rclaude --headless
  -> spawns: claude --print --output-format stream-json --input-format stream-json
             --include-partial-messages --permission-prompt-tool stdio
  -> stdin:  NDJSON user messages, control_request (set_model, interrupt), control_response (permissions)
  -> stdout: NDJSON system/init, assistant, user, stream_event, result, rate_limit_event, control_request
```

**Headless vs PTY tradeoffs:**

| Headless gives | PTY gives |
|---|---|
| Token-by-token streaming | Web terminal |
| Exact cost per turn (`total_cost_usd`) | Clipboard capture (OSC 52) |
| Rate limit status and reset times | |
| Dynamic model switching (`set_model`) | |
| Dynamic effort switching (`update_environment_variables`) | |
| Turn interruption (`interrupt`) | |
| Full session metadata in init | |
| Slash command autocomplete data | |

**Permission flow:** `--permission-prompt-tool stdio` sends `control_request` with
`subtype: "can_use_tool"` for sensitive writes. Agent Host checks auto-approve rules
(rclaude.json + built-in rules), then auto-approves or forwards to dashboard.

**Streaming:** CC sends `stream_event` with `content_block_delta`/`text_delta`.
Agent Host unwraps and forwards as `stream_delta` WS messages.

**Subagent routing:** Any entry carrying an agent discriminant routes to the subagent
transcript via `onSubagentEntry(agentId, entry)` and never falls through to the parent
stream. Assistant/user entries carry `parent_tool_use_id` (resolved to the task id via the
single `monitors.agentToolUseToTask` map, falling back to the tool_use id itself when the
`task_started` mapping is missing); system `task_progress`/`task_notification` frames carry
`task_id` directly (the task id IS the agent scope, so no lookup is needed). Monitor task
frames are the one exception -- they stay in the parent stream. The broker re-checks the same
discriminant as a defense-in-depth backstop against stale host binaries.

**Edit diffs:** CC puts `structuredPatch`, `oldString`, `newString` on `tool_use_result`.
Stream backend copies to camelCase `toolUseResult`. Agent Host's `augmentEditPatches` caches
Edit inputs from assistant entries and computes patches for results.

**AskUserQuestion (headless only):** `can_use_tool` with `tool_name: "AskUserQuestion"` ->
agent host intercepts -> `ask_question` WS -> dashboard shows banners -> user answers ->
`control_response` with `{behavior: "allow", updatedInput: {questions, answers}}`.

**Plan Mode (headless only):** Via `can_use_tool` control_request flow.
- EnterPlanMode: agent host checks `allowPlanMode` config, auto-approves, broadcasts `plan_mode_changed`
- ExitPlanMode: agent host reads plan from `~/.claude/plans/` (most recent `.md`), forwards as
  `plan_approval` WS. Dashboard renders in DialogModal. Auto-approves if WS disconnected.
- Config: `allowPlanMode` in `.rclaude/rclaude.json` (default: true). `RCLAUDE_NO_PLAN_MODE=1` for agents.
- CC writes plan to `~/.claude/plans/{slug}.md` before firing -- plan NOT in `can_use_tool` input.

**Env vars:**
- `RCLAUDE_HEADLESS=1` - enable headless mode
- `RCLAUDE_SHOW_TRANSCRIPT=1` - dump raw NDJSON to stderr
- `RCLAUDE_SHOW_TRANSCRIPT_PRETTY=1` - colorized indented JSON to stderr
- `RCLAUDE_SHOW_WEBSOCKET_MESSAGES=1` - log all WS traffic

## Runtime Effort Switching (`set_effort`)

Claude Code's CLI does NOT expose a `set_effort` control request subtype.
The runtime *setters* remain `set_model`, `set_permission_mode`,
`set_max_thinking_tokens` (confirmed in the 2.1.160 binary). The `/effort`
slash command works interactively but is NOT reachable through
`control_request` in stream-json mode.

> The broader control_request union is much larger than these three setters --
> 2.1.160 also ships getters (`get_context_usage`, `get_session_cost`,
> `get_binary_version`, `get_settings`), session controls (`rename_session`,
> `set_color`), MCP controls (`mcp_call`, `mcp_reconnect`, `mcp_toggle`,
> `reload_plugins`), file/task controls (`read_file`, `rewind_files`,
> `stop_task`, `background_tasks`), and host-callbacks (`request_user_dialog`,
> `elicitation`, `oauth_token_refresh`). None are wired into rclaude yet. The
> full catalog + which to adopt: `docs/stream-json-protocol.md` and
> `.claude/docs/plan-cc-2.1.160-protocol-audit.md`.

**But** CC does expose `update_environment_variables` as a top-level message
type. The handler mutates `process.env[K] = V` on the CC process itself (not
just child processes):

```js
if (_.type === "update_environment_variables") {
  for (let [K, O] of Object.entries(_.variables)) process.env[K] = O
}
```

And CC reads `process.env.CLAUDE_CODE_EFFORT_LEVEL` **lazily per-turn** (not
cached at startup):

```js
function MYH() {  // effort resolver
  let H = process.env.CLAUDE_CODE_EFFORT_LEVEL
  return H?.toLowerCase() === "unset" || H?.toLowerCase() === "auto" ? null : rc(H)
}
```

So to change effort level at runtime without respawning CC:

```json
{"type": "update_environment_variables", "variables": {"CLAUDE_CODE_EFFORT_LEVEL": "max"}}
```

Write that to CC's stdin (followed by `\n`), and the next turn's request to
Anthropic picks up `output_config.effort = "max"`. Setting the value to
`auto` or `unset` falls back to model default.

Exposed in rclaude as:
- `StreamProcess.sendSetEffort(level)` in `src/claude-agent-host/stream-backend.ts`
- `StreamProcess.sendUpdateEnv(variables)` for arbitrary env mutations
- `executeControl('set_effort', { effort })` in `src/claude-agent-host/index.ts` (PTY falls back to writing `/effort <level>\r`)
- `session_control` WS message with `action: 'set_effort', effort: string`
- `/effort <level>` slash command typed into the dashboard input
- MCP `control_session` tool with `action: 'set_effort'`

### Effort vs `MAX_THINKING_TOKENS` (NOT the same thing)

Anthropic's API has two distinct parameters that both affect reasoning:

| Parameter | Wire field | Env var | Controls |
|---|---|---|---|
| Thinking budget | `thinking.budget_tokens` | `MAX_THINKING_TOKENS` | Thinking depth only. Returns HTTP 400 on Opus 4.7+. |
| Effort preset | `output_config.effort` | `CLAUDE_CODE_EFFORT_LEVEL` | Thinking + tool call appetite + response length + agentic persistence. |

From Anthropic's migration docs (embedded in cli.js):

> `budget_tokens` controlled how much to *think*; `effort` controls how much
> to think *and act*, so there is no exact 1:1 mapping. Use `xhigh` for best
> results in coding and agentic use cases.

On Opus 4.7+, `thinking: {type: "enabled", budget_tokens: N}` is a 400 error.
Use `thinking: {type: "adaptive"}` + `output_config.effort` instead.

**Files:** `src/claude-agent-host/stream-backend.ts`, `docs/stream-json-protocol.md`

## Re-auditing the control surface on a CC bump

The CC binary embeds its control-protocol zod schemas verbatim -- minification
renames variables but leaves `literal("...")` string literals intact. So a free,
no-side-effects audit of every control_request subtype is one `strings` pass.
This is the sibling of the daemon-op method in
`.claude/docs/cc-daemon-control-protocol.md` § 2.5.

```bash
BIN=$(readlink -f "$(which claude)")          # ~/.local/share/claude/versions/X.Y.Z (Mach-O)

# Every control / system subtype the binary defines (snake_case zod literals):
strings -n 5 "$BIN" | grep -aoE 'literal\("[a-z_]+"\)' \
  | sed -E 's/literal\("(.*)"\)/\1/' | sort -u

# Diff two versions to see exactly what changed:
strings -n5 OLD | grep -aoE 'literal\("[a-z_]+"\)' | sort -u > /tmp/a
strings -n5 NEW | grep -aoE 'literal\("[a-z_]+"\)' | sort -u > /tmp/b
diff /tmp/a /tmp/b
```

For richer context (the `.describe(...)` text and field shapes), grab a window
around `subtype:<var>.literal("name")` in the binary with a small Python slice --
the zod object that follows lists the fields verbatim.

**Last full audit: 2.1.160 (2026-06-02).** Result: no control-subtype changes
2.1.154 -> 2.1.160; the only new `literal(...)` were a separate remote-projects
RPC (`create_project`, `list_files`, `finalize_plan`, `register_assets`, ...),
which is neither the stream-json control protocol nor the daemon socket -- it is
the `claude --remote` sandbox file/project bridge. The stream-json doc's catalog
had simply drifted since 2.1.96; it is now current.

## MCP Channel

When started with `--channels` (default ON), rclaude becomes an MCP Streamable HTTP
server. Disable with `--no-channels` or `RCLAUDE_CHANNELS=0`.

```
Dashboard input -> broker WS -> rclaude -> MCP notification
  -> Claude sees <channel source="rclaude">message</channel>
```

Requires `--dangerously-load-development-channels server:rclaude` (auto-confirmed).
MCP config: `.claude/.rclaude/mcp-{id}.json`.

**MCP tools:** `notify`, `share_file`, `list_conversations`, `send_message`,
`toggle_plan_mode`, `tasks`, `set_task_status`, `dialog` -- always available
regardless of channel state.

**CC limitation (2.1.83+):** `AskUserQuestion` and plan mode disabled when channels
active. Headless mode does NOT use channels, so these tools work there.

### `spawn_conversation` -- sentinel profile / pool

`spawn_conversation` (and its broker-side twin in `src/broker/routes/mcp-server.ts`)
accepts two optional sentinel-profile knobs. A profile is a separate Claude account /
`CLAUDE_CONFIG_DIR` on the host -- different OAuth token, billing, MCP set, defaults.

| Param | Type | Meaning |
|---|---|---|
| `profile` | `string` (1-63 chars) | Either a **literal profile name** to pin (Fixed selection, e.g. `work`) or a **SelectionMode token** (`default` \| `balanced` \| `random`). When omitted, the sentinel applies its `defaultSelection` -- typically the implicit `default` profile (`$HOME/.claude`). |
| `pool` | `string` (`[a-z0-9-]{1,63}`) | A **named profile subset** that constrains `balanced`/`random` selection (e.g. `work`). Ignored when `profile` is a literal name (Fixed wins). When omitted, the sentinel substitutes its configured `defaultPool` (itself defaulting to `default`). |

Precedence: a literal `profile` name always wins; `pool` only matters for
Balanced/Random. The broker validates both against the sentinel's reported
`profiles` / `pools` registry and rejects unknown values with a structured error
listing the known names. Profile env (config dir, API keys) is resolved
sentinel-side only -- the broker never holds it (PROFILE-ENV BOUNDARY covenant).

**Discovery:** call `list_hosts` -- each sentinel reports its configured profiles
and pools. When both `profile` and `pool` are omitted the spawn falls through
to the target sentinel's `defaultSelection` -- the broker does not infer the
caller's profile. Schema lives in `src/shared/spawn-schema.ts`; broker
validation in `src/broker/spawn-dispatch.ts`.

## Transport Abstraction

**HIGH-LEVEL FUNCTION -> HIGH-LEVEL CALLBACK -> RCLAUDE RESOLVES TRANSPORT**

MCP tool handlers MUST NEVER call transport-specific functions directly. Call
high-level callbacks (e.g. `onDeliverMessage`), `index.ts` wires to correct transport:

- **PTY+channel**: `pushChannelMessage`
- **Headless**: `streamProc.sendUserMessage` (stdin `<channel>` tag)

MCP channel module declares needs via `McpChannelCallbacks`, `index.ts` fulfills.
Headless has no MCP channel connection -- `pushChannelMessage` silently drops messages.
