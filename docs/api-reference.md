# API Reference

## Message Router

All WS messages dispatch through `message-router.ts` to handler files in
`src/broker/handlers/`. No switch/case in index.ts.

**Adding a new message type:**
1. Create handler in the appropriate handler file (or new file)
2. Register: `registerHandlers({ my_message_type: myHandler })`
3. New file? Add to `handlers/index.ts` barrel

**HandlerContext API:**
- `ctx.ws` - WebSocket connection
- `ctx.sessions` - session store
- `ctx.caller` / `ctx.callerSettings` - resolved caller session + project settings
- `ctx.reply(msg)` - send JSON to caller
- `ctx.broadcast(msg)` - all dashboard subscribers (ONLY global messages)
- `ctx.broadcastScoped(msg, cwd)` - subscribers with chat:read for this CWD (USE THIS for session data)
- `ctx.push.sendToAll(payload)` - web push notification
- `ctx.links` - persisted link operations
- `ctx.logMessage(entry)` - inter-session message log
- `ctx.log.info/error/debug(msg)` - contextual logger
- `ctx.requireBenevolent()` / `ctx.requireAgent()` / `ctx.requireSession()` - guards

**Guards** throw `GuardError`, router catches and replies `{type}_result` with error.

## WS Messages

Dashboard sends `{ type, ...data }`, handler replies `{ type: '{type}_result', ok, ... }`.

| WS message | Handler | Purpose |
|---|---|---|
| `send_input` | `control-panel-actions.ts` | Send text to session |
| `dismiss_session` | `control-panel-actions.ts` | Remove ended session |
| `revive_session` | `control-panel-actions.ts` | Wake dead session via agent |
| `update_settings` | `control-panel-actions.ts` | Save global settings |
| `update_project_settings` | `control-panel-actions.ts` | Save per-project settings |
| `delete_project_settings` | `control-panel-actions.ts` | Clear per-project settings |
| `update_session_order` | `control-panel-actions.ts` | Save sidebar tree order |
| `terminate_session` | `channel.ts` | Kill active session |
| `subscribe` | `channel.ts` | Dashboard subscribe |
| `channel_subscribe` | `channel.ts` | Per-session stream subscribe |
| `channel_send` | `channel.ts` | Inter-session messaging |
| `terminal_attach/data/resize` | `terminal.ts` | Terminal I/O |
| `file_*` | `files.ts` | File editor (has requestId pattern) |
| `voice_*` | `voice.ts` | Voice streaming |
| `recap_create` | `recap.ts` | Kick off a period recap (project URI or `*`); optional `template`/`options` select a deliverable shape (see [Recap Templates](#recap-templates)) |
| `recap_cancel` | `recap.ts` | Cancel an in-flight recap |
| `recap_dismiss_failed` | `recap.ts` | Hide a failed recap card from the widget |
| `recap_list` | `recap.ts` | List recap summaries (filtered server-side by permission) |
| `recap_get` | `recap.ts` | Full recap doc (+ optional logs) |
| `recap_search_request` | `recap.ts` | FTS5 search across recaps the caller can read (MCP RPC) |
| `recap_mcp_get_request` | `recap.ts` | Recap by id, MCP-correlated via `requestId` |
| `recap_mcp_list_request` | `recap.ts` | List recaps for a project, MCP-correlated |

**Recap broadcasts** (broker -> dashboard):
- `recap_created { recapId, cached, requestId? }` -- reply to `recap_create`
- `recap_progress { recapId, status, progress, phase, log? }` -- per-phase tick
- `recap_complete { recapId, title, markdown, meta }` -- terminal success
- `recap_error { error, recapId?, requestId? }` -- terminal failure (also fires for malformed requests)
- `recap_list_result { recaps }`, `recap_get_result { recap, logs? }`
- `recap_search_result`, `recap_mcp_get_result`, `recap_mcp_list_result` (carry MCP `requestId`)

## HTTP Endpoints

**Principle:** WebSocket for real-time data. HTTP for auth, bootstrap, request/response.

**Bootstrap GETs:**
- `GET /sessions/:id/events` - bulk event history
- `GET /sessions/:id/transcript` - bulk transcript
- `GET /sessions/:id/subagents/*` - subagent data
- `GET /api/settings` - global settings
- `GET /api/settings/projects` - project settings
- `GET /api/session-order` - sidebar tree
- `GET /api/capabilities` - server feature flags

**Request/response (need WS req/res abstraction):**
- `POST /api/settings/projects/generate-keyterms` - LLM call
- `POST /api/push/subscribe` - push subscription

**Data queries:**
- `GET /api/shared-files`, `GET /api/links/messages`
- `GET /api/stats`, `/api/stats/turns`, `/api/stats/hourly`, `/api/stats/summary`

**Auth (must stay HTTP):**
- `GET /auth/status`, `POST /auth/login/*`, `POST /auth/register/*`, `POST /auth/logout`
- `POST /api/admin/impersonate` - create auth token for another user (admin only, debugging)

**Recap routes** (`src/broker/routes/recaps.ts`):
- `GET /api/recaps` - list with `?projectUri=`, `?status=`, `?limit=`. Filtered
  server-side by `chat:read` per-project; cross-project recaps are admin-only
  (per decision 19, creator-only -- conservative server-side until creator
  field flows through to summary).
- `GET /api/recaps/:id` - full PeriodRecapDoc as JSON (markdown included).
- `GET /api/recaps/:id/markdown` - text/markdown attachment, filename
  `recap-{project-slug}-{period}-{YYYY-MM-DD}.md`. Returns 409 if not done.
- `GET /api/recaps/:id/logs` - RecapLogEntry[] for debugging a job.
- `GET /api/recap-templates` - list the built-in templates + their declared
  options for a UI picker. Permission-gated (admin OR any authenticated user --
  templates are fleet metadata, not project data). Returns
  `{ templates: [...], defaultTemplateId }`; the Liquid `body` is NOT exposed.
  See [Recap Templates](#recap-templates).
- `POST /api/recaps/:id/share` - mints a polymorphic share token with
  `targetKind='recap'` and **empty permissions array**. Returns
  `{ token, expiresAt, shareUrl, targetKind, targetId }`. The recap share
  grants no project access -- only the public viewer endpoint.
- `GET /api/share/recap/:token` - **PUBLIC** (token is the auth). Returns
  the recap's markdown + safe metadata (title, subtitle, period, model,
  cost, expiry). Never returns createdBy or projectUri.
- `GET /r/:token` - pretty share URL. Redirects to
  `/?share=TOKEN&kind=recap`; the SPA's share-mode then mounts
  `<PublicRecapView>` standalone (no project chrome).

**Polymorphic shares** (Phase 11): `ConversationShare.targetKind` is now
`'conversation' | 'recap'` and `targetId` is the kind-specific id. Existing
hash-form shares (`/#/share/TOKEN`) remain conversation kind by default.

**Scheduled tasks** (cron-triggered project spawns -- see
[`scheduled-tasks.md`](scheduled-tasks.md)). ALL require the `spawn` permission,
because a schedule is a spawn that fires later, unattended:
- `GET /api/scheduled-tasks` - all schedules; `?project=<uri>` filters
- `POST /api/scheduled-tasks` - create. 400s on an unparseable cron or an unknown
  IANA timezone, quoting the failing field
- `PATCH /api/scheduled-tasks/:id` - any subset; the MERGED record is re-validated
  (a patch that is individually valid can still produce an impossible schedule)
- `DELETE /api/scheduled-tasks/:id` - removes the schedule and its run history
- `POST /api/scheduled-tasks/:id/run` - fire now, off-schedule. Does NOT stamp the
  fire marker, so it can neither suppress nor double the real run
- `GET /api/scheduled-tasks/:id/runs` - history, newest first; `?limit=`

WS broadcasts: `scheduled_tasks_updated` (full list after any change) and
`scheduled_task_run` (one firing).

**Deprecated (WS equivalents exist):**
- `POST /sessions/:id/input` -> `send_input` WS
- `POST /sessions/:id/revive` -> `revive_session` WS
- `DELETE /sessions/:id` -> `dismiss_session` WS
- `POST /api/settings` -> `update_settings` WS
- `POST/DELETE /api/settings/projects` -> `update/delete_project_settings` WS
- `POST /api/session-order` -> `update_session_order` WS

## Recap Templates

Named, fleet-wide **templates** let one recap engine produce different
deliverables (a reflective recap, a ship log, an agent brief) by swapping the
*presentation* prompt and toggling options -- without touching extraction,
storage, or the protocol.

**Re-present, not re-extract.** A recap runs one or two LLM prompts:

```
INPUT < 50k chars  -> ONESHOT  : 1 prompt  (buildPrompt)
INPUT >= 50k chars -> CHUNKED  : MAP (xN, parallel) + SYNTHESIZE (1)
```

The **MAP** prompt ("extract EVERYTHING") is a CONSTANT -- never templated, kept
byte-stable for OpenRouter cache reuse. Templates live ONLY in the **ONESHOT**
and **SYNTHESIZE** prompts ("build THIS deliverable from the material"). Both
wrappers feed from one shared Liquid body (a `path == "synthesize"` discriminator
carries the only framing difference, and the fixed frontmatter+body contract is
injected once after the branch), so the two paths cannot drift. A template works
within the **fixed** frontmatter vocabulary (`features`, `bugs`, `fixes`,
`decisions`, `dead_ends`, `gotchas`, `frustrations`, `incidents`,
`open_questions`); it cannot introduce a new *extracted* category (that would mean
touching the constant MAP prompt -- out of scope for v1). **v1 templates are
fleet-wide** (the all-projects `'*'` path); per-project templating is deferred.

### Template model

A template is one self-contained `.yml` file under `recap-templates/`, loaded and
**zod-validated** by `src/broker/recap/templates.ts` on every `recap_create` (no
hot-reload machinery -- the read is tiny). A malformed file is **skipped and
logged** as a structured event, never silently mis-rendered; the engine falls back
to the default template. Fields:

| Field | Meaning |
|---|---|
| `id` | kebab-case template id (the wire value) |
| `label` / `description` | human-facing, surfaced by `GET /api/recap-templates` |
| `scope` | `fleet` (v1; field present for forward-compat) |
| `audience` | `human` or `agent` -- the template OWNS audience, but an explicit caller `audience` wins |
| `defaults` | `retrospect` / `customerFriendly` booleans + base `signals` list |
| `sections` | subset + order of the FIXED frontmatter vocabulary (no new fields) |
| `options[]` | declared toggles (see below) |
| `body` | the shared presentation prompt, authored as a LiquidJS template (sandboxed -- no code execution) |

### Built-in templates

| id | Audience | What |
|---|---|---|
| `project-recap` (default) | human | The reflective all-projects recap. The **anchor**: reproduces the pre-template `'*'` human prompt byte-for-byte (regression-gated by `anchor-prompt.test.ts`). |
| `shipped-report` | human | The marquee fleet **ship log**: features/bugs/fixes + commit hashes (7-char) + conversation ids (8-char), blameless tone, optional cost + per-project grouping. |
| `agent-handoff` | agent | Fleet orientation brief. Reproduces the in-code agent prompt byte-for-byte (gated by `agent-prompt.test.ts`). |

A default recap with no `template` named picks the built-in for the **resolved
audience** (`audience: 'agent'` -> `agent-handoff`, otherwise `project-recap`), so
the recipe stays self-describing (correct cache key + `args_json`).

### Option model -- two wires

An option declared on a template resolves through one or both of two distinct
mechanisms:

| Kind | Declared by | Mechanism | Acts |
|---|---|---|---|
| **Technical** | `signal: <name>` | adds/removes a gather signal | code, BEFORE any prompt |
| **Prompt tweak** | (no `signal`) | exposed as `options.<id>` boolean in the Liquid body | template text |

**An option may be BOTH.** `shipped-report`'s `commit_stats` (default `true`,
`signal: commits`) flips the `commits` gather signal AND exposes an
`options.commit_stats` boolean the body reads to decide whether to render the
files/+/- stats column. `include_cost` works the same with the `cost` signal;
`group_by_project` and `terse` are pure prompt tweaks (no signal). User
`options` overrides are merged over the template's declared defaults; unknown
keys are ignored.

### Wire / API surface (additive, no migration)

- **WS `recap_create`** (`RecapCreateMessage`) and **MCP `recap_create`** both
  accept optional `template?: string` (id; default `project-recap`) and
  `options?: Record<string, boolean>` (overrides of the template's declared option
  defaults). The resolved recipe (template id + option flags + signal set) is
  stored in the existing `args_json` column -- **no new SQLite column, no
  migration**. The recap **cache key** folds `tmpl:<id>` + the resolved options,
  so a different template OR a different toggle produces a distinct key.
- **`GET /api/recap-templates`** lists the built-ins + their declared options for
  a future picker UI (the Liquid body is not exposed). Permission-gated to admin
  OR any authenticated user.

Example MCP invocation (a fleet ship log for the last 7 days):

```js
recap_create({
  projectUri: '*',
  period: { label: 'last_7' },
  audience: 'human',
  template: 'shipped-report',
  options: { include_cost: true, commit_stats: true, group_by_project: true },
  inform_on_complete: true,
})
```

### Editing templates (the experiment loop)

Built-ins are committed at `recap-templates/*.yml` and baked into the broker image.
`docker-compose.yml` also **bind-mounts** them read-only:

```yaml
- ./recap-templates:/srv/recap-templates:ro
```

The loader prefers `/srv/recap-templates` when present, so the mount overlays the
baked copy. **Edit a `.yml` on the host and the next `recap_create` picks it up
live -- no rebuild.** This is the prompt-iteration loop: tune `shipped-report.yml`,
re-run the recap, repeat; commit when happy. (The template/options *wire* and the
agent-path routing ship in the broker bundle -- a rebuild is only needed to change
those, not to edit a template body.)

## Settings System

**Server settings** (`GET/POST /api/settings`) - shared across clients:
- `{cacheDir}/global-settings.json`, Zod-validated, soft-fail
- Fields: `idleTimeoutMinutes`, `userLabel`, `agentLabel`
- Broadcast `settings_updated` WS on change

**Client prefs** (`localStorage:control-panel-prefs`) - per-browser:
- Fields: `showInactiveByDefault`, `compactMode`, `showVoiceInput`
- `usePrefs()` hook, `prefs-changed` window event for sync

**Project settings** (`GET/POST/DELETE /api/settings/projects`) - per-project:
- `{cacheDir}/project-settings.json`, keyed by CWD
- Fields: `label`, `icon`, `color`, `keyterms[]`, `defaultLaunchMode`, `defaultEffort`, `defaultModel`, `trustLevel`
