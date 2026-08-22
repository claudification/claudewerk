# Claude Code Headless Control Protocol (stream-json / NDJSON)

**Author:** CLAUDEWERK / jonas
**Status:** Working spec. Framing, control channel, and the OAuth login flow are
verified against a live `claude` process. Items marked _(declared, unverified)_
are present in the command surface but were not exercised end-to-end.

---

## 0. What this is

`claude` (the Claude Code CLI) can run **headless**: instead of a terminal UI it
speaks **newline-delimited JSON** (NDJSON / JSONL) over stdin/stdout. One JSON
object per line, each with a top-level `"type"`.

Two planes share that pipe:

1. **The turn plane** — you send user messages, Claude streams back assistant
   text, tool calls, and a final result.
2. **The control plane** — a request/response RPC channel (`control_request` /
   `control_response`) carried on the *same* stdin/stdout. It runs in **both
   directions**: you send control requests to change model/effort/permission
   mode or to drive login; Claude sends control requests to you to ask for tool
   permission.

This document specifies both, with the **OAuth login flow** (authenticate a
Claude subscription entirely over the pipe, no browser callback server) as the
headline. Nothing here assumes any particular host, broker, or framework — it is
a direct contract with the `claude` binary.

---

## 1. Launching the process

Spawn `claude` with stdin/stdout/stderr as pipes and this argv:

```
claude \
  --print \
  --output-format stream-json \
  --input-format  stream-json \
  --verbose \
  --include-partial-messages \
  --replay-user-messages \
  --permission-prompt-tool stdio \
  --settings <path-to-settings.json> \
  [ your other flags: --model, --permission-mode, --resume <id>, --session-id <id>, ... ]
```

| Flag | Why |
|---|---|
| `--print` | Non-interactive (headless) mode. |
| `--output-format stream-json` | Claude emits NDJSON on **stdout**. |
| `--input-format stream-json` | Claude reads NDJSON on **stdin**. |
| `--verbose` | **Required** with `--print` + `--output-format stream-json` since CC **2.1.145** — the combination is rejected without it. |
| `--include-partial-messages` | Enables `stream_event` token deltas (drop it if you only want whole messages). |
| `--replay-user-messages` | Claude echoes each user message back as a `user` line (useful for ordering / dedup). |
| `--permission-prompt-tool stdio` | Route tool-permission prompts over the control channel (§5.2) instead of a TTY. |
| `--settings <path>` | Path to a Claude Code `settings.json`. |

**Environment variables of note** (passed in the child's `env`):

| Var | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` | Selects the credential/profile directory. Point different logins at different dirs to keep them isolated. Credentials land in `<dir>/.credentials.json` (and/or the OS keychain). |
| `CLAUDE_CODE_EFFORT_LEVEL` | Reasoning effort. Read **lazily per turn**, so it can be mutated mid-session (§4.2). |

**Framing rules:**
- Every stdout line is one complete JSON object. Buffer partial reads and split
  on `\n`.
- Every stdin write must be a single-line JSON object followed by `\n`, then
  flush.
- Non-JSON stdout lines do not occur in normal operation; log and skip if seen.
- **stderr** is human-readable diagnostics, not protocol — capture it for
  debugging only.

---

## 2. Message envelope

```jsonc
{ "type": "<string>", ... }   // exactly one per line
```

**Inbound (claude → you):**

| `type` | Meaning | Section |
|---|---|---|
| `system` | Lifecycle + out-of-band events (init, retries, thinking, ...) | §3.1 |
| `assistant` | An assistant message (text + tool_use blocks) | §3.2 |
| `user` | Echo of a user message (with `--replay-user-messages`) or tool_result | §3.2 |
| `stream_event` | Partial-message delta (with `--include-partial-messages`) | §3.3 |
| `result` | End-of-turn summary (cost, turns, usage) | §3.4 |
| `control_request` | Claude asking **you** for something (tool permission) | §5.2 |
| `control_response` | Claude's reply to a control request **you** sent | §5.1 |
| `rate_limit_event` | Rate-limit status update | §3.5 |
| `queue-operation` | Message-queue bookkeeping | — |

**Outbound (you → claude):**

| `type` | Meaning | Section |
|---|---|---|
| `user` | Send a user turn | §4.1 |
| `update_environment_variables` | Mutate env (effort, arbitrary vars) mid-session | §4.2 |
| `control_request` | Invoke an RPC (interrupt, set_model, login, ...) | §5.1 |
| `control_response` | Answer a permission prompt Claude sent you | §5.2 |

---

## 3. Inbound messages

### 3.1 `system`

Discriminated by `subtype`. Common subtypes:

| `subtype` | Payload highlights | Notes |
|---|---|---|
| `init` | `session_id`, `model`, `permissionMode`, tool/command/mcp inventory | First message after boot. Capture `session_id`. |
| `api_retry` | `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` | Claude is retrying an API call with backoff. **`error_status: 401` = auth failure** (see §6.4). |
| `thinking_tokens` | `estimated_tokens`, `estimated_tokens_delta` | ~1.5s liveness pings during extended thinking. Ephemeral; do not persist. |
| `commands_changed` | `commands: [{name, description, argumentHint}]` | The `/`-command catalog (re)loaded. |
| `compact_boundary` | — | Context was compacted at this point. |
| `session_state_changed` | `state` | Session state transition. |
| `post_turn_summary` | `status_category`, `title` | Post-turn summary card. |
| `can_use_tool` (as a `control_request`, not `system`) | see §5.2 | |

Example:

```json
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":556.5,"error_status":401,"error":"authentication_failed","uuid":"18ce...","seq":14}
```

### 3.2 `assistant` / `user`

Anthropic Messages-API shapes wrapped in an envelope:

```jsonc
{ "type": "assistant", "message": { "role": "assistant", "content": [ { "type": "text", "text": "..." }, { "type": "tool_use", "id": "...", "name": "...", "input": {...} } ] }, "parent_tool_use_id": null }
```

`user` lines are either the echo of a message you sent (`--replay-user-messages`)
or a `tool_result` produced during a turn. `parent_tool_use_id` (when non-null)
attributes the line to a sub-agent's tool call.

### 3.3 `stream_event`

Incremental deltas for the message currently being generated (only with
`--include-partial-messages`). The inner `event` mirrors the Anthropic streaming
event (`content_block_delta`, etc.). Use for token-by-token UI; the whole message
still arrives as an `assistant` line at turn end.

### 3.4 `result`

Terminal message of a turn:

```jsonc
{ "type": "result", "subtype": "success", "total_cost_usd": 0.0123, "num_turns": 3, "usage": { ... } }
```

`subtype` is `success` or an error variant. This is the signal that the turn is
complete and Claude is idle again.

### 3.5 `rate_limit_event`

```jsonc
{ "type": "rate_limit_event", "rate_limit_info": { "status": "allowed|throttled", "rateLimitType": "...", "resetsAt": <seconds>, "utilization": <0..1> } }
```

`resetsAt` is in **seconds** (normalize to ms as needed).

---

## 4. Outbound messages (turn plane)

### 4.1 Send a user turn

```json
{"type":"user","session_id":"","message":{"role":"user","content":"your prompt text"},"parent_tool_use_id":null}
```

- `content` may be a string or a Messages-API content array.
- `session_id` may be empty; Claude tracks the session itself.
- Claude replies with `stream_event`s (if enabled), `assistant` line(s),
  possibly `control_request` permission prompts, and finally a `result`.

### 4.2 Mutate environment (effort switching)

There is **no** `set_effort` control request. Instead push env updates:

```json
{"type":"update_environment_variables","variables":{"CLAUDE_CODE_EFFORT_LEVEL":"high"}}
```

Arbitrary vars work the same way; `CLAUDE_CODE_EFFORT_LEVEL` is read lazily on the
next turn, so this is the supported way to change reasoning effort at runtime.

---

## 5. The control channel (RPC)

### Envelopes

**Request** (either direction):

```jsonc
{ "type": "control_request", "request_id": "<unique>", "request": { "subtype": "<verb>", ...args } }
```

**Response** (either direction):

```jsonc
{ "type": "control_response",
  "response": {
    "subtype": "success" | "error",
    "request_id": "<echoes the request>",
    "response": { ...payload },   // present on success; shape varies by verb
    "error": "<text>"             // present on error
  } }
```

**Rules**
- `request_id` is any string unique within the process lifetime; correlate
  responses by it. (Reference implementation uses `"<prefix>-<counter>"`, e.g.
  `dbg-7`.)
- A verb either resolves with `subtype:"success"` (+ optional `response`) or
  `subtype:"error"` (+ `error`). Apply your own timeout — a verb that blocks on a
  human (e.g. login) can take arbitrarily long.
- The channel is **bidirectional**: §5.1 = requests you originate; §5.2 =
  requests Claude originates.

### 5.1 Requests you send (host → claude)

| `subtype` | `request` args | Success `response` | Notes |
|---|---|---|---|
| `interrupt` | — | — | Cancel the in-flight turn. |
| `set_model` | `{ "model": "<id>" }` | — | Switch model mid-session. |
| `set_permission_mode` | `{ "mode": "default\|plan\|acceptEdits\|auto\|bypassPermissions" }` | — | |
| `claude_authenticate` | `{ "loginWithClaudeAi": true }` | `{ "manualUrl": "...", "automaticUrl": "..." }` | Start Claude subscription login (§6). **Verified.** |
| `claude_oauth_callback` | `{ "authorizationCode": "...", "state": "..." }` | `{ "account": { "email", "organization", "subscriptionType", "apiProvider" } }` | Complete login (§6). **Verified.** |
| `claude_oauth_wait_for_completion` | `{}` | — | Block until an in-progress login settles. _(declared, unverified — the callback already returns the account, so this is usually unnecessary.)_ |
| `mcp_authenticate` | `{ "serverName": "...", "redirectUri": "..." }` | provider authorization URL | Begin an **MCP server's** OAuth. _(declared, unverified.)_ |
| `mcp_oauth_callback_url` | `{ ...redirected callback URL with code }` | — | Complete an MCP server OAuth. _(declared, unverified.)_ |
| `mcp_clear_auth` | `{ "serverName": "..." }` | — | Clear stored MCP creds. _(declared, unverified.)_ |

Example round-trip (set model):

```
→ {"type":"control_request","request_id":"mdl-1","request":{"subtype":"set_model","model":"claude-sonnet-5"}}
← {"type":"control_response","response":{"subtype":"success","request_id":"mdl-1"}}
```

### 5.2 Requests Claude sends you (tool-permission prompts)

With `--permission-prompt-tool stdio`, before running a gated tool Claude sends:

```jsonc
{ "type": "control_request", "request_id": "<id>",
  "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": { ...toolInput }, "decision_reason": "..." } }
```

You **must** answer with a `control_response` echoing `request_id`:

**Allow:**
```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"allow","updatedInput":{},"toolUseID":"<optional>"}}}
```

**Deny:**
```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"deny","message":"why it was denied","toolUseID":"<optional>"}}}
```

- `updatedInput` lets you rewrite the tool's arguments before it runs (`{}` = run
  as-is).
- The deny `message` is surfaced to the model (e.g. an `ExitPlanMode` rejection
  reason), so make it meaningful.
- Note the envelope: it is a `control_response` with an **outer**
  `subtype:"success"` (the transport succeeded) wrapping an **inner**
  `behavior:"allow"|"deny"` (your decision).

---

## 6. The OAuth login flow (headless subscription login)

Log a Claude subscription into a headless process **without** a browser callback
server. Claude runs a standard PKCE authorization-code flow and owns the
`code_verifier` + `state` internally — you only relay a URL out and a code back.

### 6.1 Sequence

```
  host                              claude                         human + browser
   |  control_request                 |                                   |
   |  claude_authenticate ----------->|                                   |
   |  {loginWithClaudeAi:true}        |  (generates PKCE verifier+state)   |
   |                                  |                                   |
   |<-- control_response -------------|                                   |
   |   {manualUrl, automaticUrl}      |                                   |
   |                                                                      |
   |  show manualUrl to the human ------------------------------------->  | opens URL,
   |                                                                      | authorizes,
   |  human pastes back the code (+state) <-----------------------------  | copies code
   |                                  |                                   |
   |  control_request                 |                                   |
   |  claude_oauth_callback --------->|  (exchanges code+verifier          |
   |  {authorizationCode, state}      |   for tokens, writes creds)        |
   |                                  |                                   |
   |<-- control_response -------------|                                   |
   |   {account:{email,...}}          |                                   |
```

### 6.2 Step 1 — start

```
→ {"type":"control_request","request_id":"login-1","request":{"subtype":"claude_authenticate","loginWithClaudeAi":true}}
← {"type":"control_response","response":{"subtype":"success","request_id":"login-1","response":{
     "manualUrl":"https://claude.com/cai/oauth/authorize?code=true&client_id=...&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=...&code_challenge=...&code_challenge_method=S256&state=cXrw...",
     "automaticUrl":"https://claude.com/cai/oauth/authorize?...&redirect_uri=http%3A%2F%2Flocalhost%3A55774%2Fcallback&..."
   }}}
```

**Use `manualUrl`, not `automaticUrl`.** `automaticUrl` sets `redirect_uri` to a
`http://localhost:<port>/callback` server that Claude spins up on the **machine
running `claude`** — only reachable if the human's browser is on that same
machine. `manualUrl` redirects to a hosted page that **displays the code** for
the human to copy, which works no matter where the browser is.

The `state` is embedded in the URL's query string. Parse and stash it — you use
it to CSRF-check the response in step 3.

### 6.3 Step 2 — human authorizes

The human opens `manualUrl`, approves, and lands on the redirect page which
carries the result, e.g.:

```
https://platform.claude.com/oauth/code/callback?code=a9v3...CizwDgrHQBh&state=cXrw...
```

They copy back either the **whole URL** or just the **code**. If you accept the
whole URL, parse `code` and `state` from the query string and verify the pasted
`state` equals the one you issued (reject on mismatch — that is the CSRF check
`state` exists for).

> The consent screen **cannot** be scraped via an iframe: OAuth providers send
> `X-Frame-Options: DENY` / `CSP: frame-ancestors 'none'`, and even if framed,
> the browser Same-Origin Policy blocks reading the redirected URL cross-origin.
> A real browser tab (`window.open(manualUrl, "_blank")`) + copy/paste is the
> only portable capture. This is by design, not a limitation to engineer around.

### 6.4 Step 3 — complete

```
→ {"type":"control_request","request_id":"login-2","request":{"subtype":"claude_oauth_callback","authorizationCode":"a9v3...CizwDgrHQBh","state":"cXrw..."}}
← {"type":"control_response","response":{"subtype":"success","request_id":"login-2","response":{
     "account":{"email":"jonas@duplo.org","organization":"jonas@duplo.org's Organization","subscriptionType":"Claude Max","apiProvider":"firstParty"}
   }}}
```

A `success` with an `account` block means the credentials were exchanged and
written to the profile's credential store (`<CLAUDE_CONFIG_DIR>/.credentials.json`
and/or the OS keychain). The process is now authenticated.

`claude_oauth_wait_for_completion` (`{}`) exists to block until an in-progress
login settles, but in practice `claude_oauth_callback` already returns once the
exchange is done, so it is usually unnecessary.

### 6.5 Detecting when login is needed

An expired/dead credential surfaces mid-turn as a **401 `api_retry`**:

```json
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":556.5,"error_status":401,"error":"authentication_failed"}
```

Gate on `error_status === 401`. Note `max_retries` (e.g. 10) with backoff gives a
**recovery window**: if the login is completed (§6.2–6.4) before the retries
drain, the stalled turn simply succeeds on its next attempt — no restart needed.
Surface the hint once (e.g. on `attempt <= 1`) rather than on every retry.

### 6.6 Token lifetime

After a successful login, Claude **transparently refreshes** its own access token
on use; you do not manage refresh. Because the OAuth `refresh_token` is
single-use and rotates, a profile whose credential store you drive here should be
**owned exclusively** by this process — sharing it with another concurrent
`claude` that also refreshes will rotate the token out from under one of them. A
dedicated `CLAUDE_CONFIG_DIR` per headless login avoids this.

### 6.7 Implementor's guide — what YOU must build (client side)

The protocol gives you a URL and takes back a code. Everything between is your
UI's job. Concretely, an implementor must:

1. **Send `claude_authenticate`** and await the `control_response`.
2. **Parse `manualUrl` + `state`** from the response. `state` is a query param on
   the URL.
3. **Open the URL in a real browser tab** — `window.open(manualUrl, "_blank")`.
   Do **not** try an iframe (§6.3). If your client is not a browser (CLI/TUI),
   print the URL and tell the human to open it.
4. **Collect the pasted response** — a text box accepting either the full
   redirect URL or the bare code.
5. **Parse + CSRF-check** — extract `code` (and `state` if a full URL was
   pasted); if a pasted `state` is present and differs from the one you issued,
   **reject**.
6. **Send `claude_oauth_callback`** with `{ authorizationCode: code, state:
   <the state you issued> }` and await the `control_response`.
7. **Report the `account`** on success; on a `subtype:"error"`, show `error` and
   let the human retry from step 1.

Reference implementation (TypeScript-flavoured, fake data). `send()` is your
transport that writes a `control_request` line and resolves with its
`control_response.response` — see §5 for the envelope.

```ts
// 1-2. START: get the authorize URL + the state we must echo back.
const started = await send("claude_authenticate", { loginWithClaudeAi: true });
// started === { manualUrl: "https://claude.com/cai/oauth/authorize?...&state=ST_8f3a", automaticUrl: "..." }
const manualUrl = started.manualUrl as string;
const issuedState = new URL(manualUrl).searchParams.get("state") ?? ""; // "ST_8f3a"

// 3. OPEN a real browser tab for the human to authorize (NOT an iframe).
window.open(manualUrl, "_blank", "noopener,noreferrer");

// 4. COLLECT what the human pastes back (full redirect URL or bare code):
//    e.g. "https://platform.claude.com/oauth/code/callback?code=AUTH_c0ffee&state=ST_8f3a"
//    or   "AUTH_c0ffee"
const pasted: string = await promptUserForPastedResponse();

// 5. PARSE + CSRF-check.
function parsePasted(input: string): { code: string; state?: string } {
  const s = input.trim();
  if (!s.includes("code=")) return { code: s };                 // bare code
  const qs = s.includes("?") ? s.slice(s.indexOf("?") + 1) : s; // full URL or query string
  const p = new URLSearchParams(qs);
  return { code: p.get("code") ?? s, state: p.get("state") ?? undefined };
}
const { code, state: pastedState } = parsePasted(pasted);      // { code: "AUTH_c0ffee", state: "ST_8f3a" }
if (!code) throw new Error("no authorization code in the paste");
if (pastedState && issuedState && pastedState !== issuedState) {
  throw new Error("state mismatch — paste came from a different login attempt"); // CSRF / stale URL
}

// 6. COMPLETE — always send the state WE issued.
const done = await send("claude_oauth_callback", { authorizationCode: code, state: issuedState });
// done === { account: { email: "dev@example.com", subscriptionType: "Claude Max", ... } }

// 7. REPORT.
console.log(`Logged in as ${done.account.email} (${done.account.subscriptionType})`);
```

Reactive entry point (optional): watch the stream for a `system` `api_retry` with
`error_status === 401` (§6.5) and, on `attempt <= 1`, surface an "Authorize"
affordance that runs the flow above. Finish before `max_retries` drains and the
stalled turn self-heals.

CLI/TUI variant: replace step 3 with printing the URL and step 4 with a stdin
read:

```
Open this URL to authorize, then paste the code (or the whole redirect URL):
  https://claude.com/cai/oauth/authorize?...&state=ST_8f3a
> AUTH_c0ffee
Logged in as dev@example.com (Claude Max)
```

---

## 7. End-to-end example (annotated)

```jsonc
// -- boot --
← {"type":"system","subtype":"init","session_id":"e1f2...","model":"claude-opus-4-8","permissionMode":"default", ...}

// -- a turn --
→ {"type":"user","session_id":"","message":{"role":"user","content":"list the files here"},"parent_tool_use_id":null}
← {"type":"stream_event","event":{"type":"content_block_delta", ...}}          // (partial)
← {"type":"control_request","request_id":"perm-9","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}
→ {"type":"control_response","response":{"subtype":"success","request_id":"perm-9","response":{"behavior":"allow","updatedInput":{}}}}
← {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here are the files: ..."}]}}
← {"type":"result","subtype":"success","total_cost_usd":0.004,"num_turns":1}

// -- runtime effort bump --
→ {"type":"update_environment_variables","variables":{"CLAUDE_CODE_EFFORT_LEVEL":"high"}}

// -- credential died mid-turn --
← {"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"error_status":401,"error":"authentication_failed"}
→ {"type":"control_request","request_id":"login-1","request":{"subtype":"claude_authenticate","loginWithClaudeAi":true}}
← {"type":"control_response","response":{"subtype":"success","request_id":"login-1","response":{"manualUrl":"https://claude.com/cai/oauth/authorize?...&state=ST","automaticUrl":"..."}}}
//   (human authorizes, pastes code)
→ {"type":"control_request","request_id":"login-2","request":{"subtype":"claude_oauth_callback","authorizationCode":"a9v3...","state":"ST"}}
← {"type":"control_response","response":{"subtype":"success","request_id":"login-2","response":{"account":{"email":"...","subscriptionType":"Claude Max"}}}}
//   the earlier retry loop now succeeds on its next attempt
```

---

## 8. Errors, timeouts, edge cases

- **Control errors** come back as `subtype:"error"` with an `error` string. Treat
  a missing response within your timeout as a failure too.
- **Unknown control verb** → `subtype:"error"`. There is no capability discovery
  over the wire; know the verb set (§5) ahead of time.
- **`--verbose` is mandatory** with `--print --output-format stream-json` since
  CC **2.1.145**; omitting it makes `claude` reject the invocation.
- **Ordering:** within a turn, expect `stream_event`* → `control_request`
  (permission)* interleaved → `assistant`* → `result`. `system` lines (retries,
  thinking) can arrive at any time.
- **Idempotency of login:** re-running `claude_authenticate` starts a fresh PKCE
  flow (new `state`). Always complete with the `state` from the **most recent**
  `claude_authenticate`.
- **stderr** carries stack traces and human diagnostics — never parse it as
  protocol.

---

## 9. Quick reference

**Outbound verbs (you → claude):**
`user`, `update_environment_variables`, and `control_request` subtypes:
`interrupt`, `set_model`, `set_permission_mode`, `claude_authenticate`,
`claude_oauth_callback`, `claude_oauth_wait_for_completion`, `mcp_authenticate`,
`mcp_oauth_callback_url`, `mcp_clear_auth`.

**Inbound types (claude → you):**
`system` (`init`, `api_retry`, `thinking_tokens`, `commands_changed`,
`compact_boundary`, `session_state_changed`, `post_turn_summary`, ...),
`assistant`, `user`, `stream_event`, `result`, `rate_limit_event`,
`control_request` (`can_use_tool`), `control_response`, `queue-operation`.

**Login in three lines:**
`claude_authenticate {loginWithClaudeAi:true}` → open `manualUrl` → paste code →
`claude_oauth_callback {authorizationCode, state}` → authenticated.
