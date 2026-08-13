# Data Stores

## Project Board (markdown on disk)

Kanban cards, owned by the SENTINEL (so the board works with no live agent host).
Code: `src/shared/project-{paths,card-file,card-read,card-write,legacy,upgrade}.ts`,
re-exported through `project-store.ts`.

```
.rclaude/project/
  cards/<id>.md                              CANONICAL. never moves. the only place a card lives.
  quests/<petname>/                          quest manifests (docs/quest-guide.md)
  priority.md  gate.conf                     board-level config
```

**A card's `id` is its whole primary key.** Its lane is the `status:` frontmatter
key, so changing lanes rewrites one line in a file that never moves. That is what
makes a link written a year ago still open the right card.

**ONE DIRECTORY, NO MIRRORS.** There used to be a generated `views/<status>/<id>.md`
symlink farm. It was deleted 2026-08-13: nothing in the codebase read it, the
watcher had to explicitly exclude it to avoid firing twice per change, every write
paid to maintain it, and it drifted anyway -- one live board had 43 of 301 cards
with no link at all, which reads to a human as "these cards don't exist". A lane is
one line inside one file; filter the cards instead. Reading a whole 355-card board,
bodies included, is ~20ms, which is also why there is no index/cache file.

Links written when the farm existed still resolve: `canonicalizeCardPath` keeps
accepting `views/<lane>/<id>.md` forever. `board:doctor` reports a leftover farm
(`views-leftover`) but never deletes it.

| Invariant | Why |
|---|---|
| The path is fixed from create to delete | links, transcripts and docs can name a card forever |
| `id` is deduped once, at create, then immutable | a lane change used to be able to *rename* the card |
| Only `setProjectTaskStatus()` writes `status:` | one writer, so the lane can't drift |
| Every write preserves unknown frontmatter | the DONE-gate's `evidence_*`, plus `gate:`, `test_cmd:`, `base:` |
| No derived copy of the lane structure exists | a second thing to keep true is a second thing to get wrong |
| Legacy `<status>/` lane dirs are read-only | drained by the upgrade, or lazily on the next write |

Shape of the model: notmuch (files never move, state is an index), Maildir (the
unique filename *is* the identity), Jekyll/Hugo (flat dir, frontmatter is the
whole taxonomy).

### Checking a board's health

```
bun run board:doctor                          # this project
bun run board:doctor --root ~/projects/foo    # another one
bun run board:doctor --all ~/projects -q      # every board under a dir
```

READ ONLY -- it never writes, moves or deletes; every finding names the command
or edit that fixes it. Exit 1 on errors, or on warnings too with `--strict`, so
it works as a CI gate. Big groups collapse to one line (`-v` to list them all).

| Check | Catches |
|---|---|
| `card-status-{missing,invalid}` | a lane the board silently coerces to `inbox` |
| `card-{unreadable,no-frontmatter,title-missing,empty-body}` | cards that are not really cards |
| `link-rot` | a card link whose target id does not exist -- clicking it does nothing |
| `views-leftover` | a pre-2026-08-13 symlink farm still on disk, now unmaintained |
| `legacy-{lane-cards,collision}` | undrained lane dirs, same id in two lanes |
| `stray-{card-file,entry}`, `cards-{nested-dir,non-card-file}` | files nothing will ever read |

Code: `src/shared/project-doctor{,-cards,-links,-layout,-types,-cli}.ts`,
entry `scripts/board-doctor.ts`. The checks are pure fs + string work, so the
same module can back a sentinel RPC or MCP tool later without moving.

### Upgrading an old board

Boards that predate this layout keep working -- reads fall back to the lane dirs
and any write migrates that card in place. To sweep a whole project at once:

```
bun run board:upgrade --root <project> --dry-run   # report only
bun run board:upgrade --root <project>             # move + back up
```

Idempotent. Backs every lane file up to `.rclaude/project/.upgrade-backup-<ts>/`
first (`--no-backup` to skip), reports same-id-in-two-lanes collisions and keeps
the card furthest along the pipeline, exits non-zero if any card could not move.

## Project Registry (SQLite)

Stable integer IDs for projects. The authoritative source of project identity --
all other stores reference `projects.id` instead of repeating CWD strings.

**Storage:** `{cacheDir}/projects.db` (separate from analytics/cost -- this is
authoritative config, not disposable time-series data)

**Table:** `projects` (id INTEGER PK, cwd TEXT UNIQUE, scope TEXT UNIQUE, slug TEXT, label TEXT)

**Scope URI scheme** (canonical form, stable):
```
{provider}://{sentinel}/{path}#{session}

claude://default/Users/jonas/projects/remote-claude            (local install -- default sentinel)
claude://default/Users/jonas/projects/remote-claude#a1b2c3d4   (specific session inside it)
claude://laptop/Users/jonas/projects/foo                       (future: multi-sentinel)
fabric://pipeline/data-etl-nightly
agent://openai/asst_abc123
```

The **authority slot is the sentinel name**. `default` means "the single-host
local install"; when multi-sentinel support lands, each host registers with
its own authority. See `src/shared/project-uri.ts` for the `DEFAULT_SENTINEL_NAME`
constant + the parse/normalize/match/compare helpers.

**Legacy URI forms** (still accepted on input, canonicalized on read):
- `claude:///path`  -- authority-empty form, upgraded to `default` by `normalizeProjectUri()`
- `claude:////path` -- pre-2026-04-25 quad-slash concat scar, collapsed then upgraded

One-shot backfill `canonicalizeUris()` rewrites any surviving legacy forms
in `store.db` and `analytics.db` on broker startup when `kv['schema-version'] < 2`.

**API:**
- `GET /api/projects` -- list all projects (admin only)

**Usage:** `getOrCreateProject(cwd, label?)` returns `Project` with integer `.id`.
Hot path uses in-memory cache (cwd -> Project). Cache miss falls through to DB.

Files: `project-store.ts`

## Analytics (SQLite)

Per-turn tool-use analytics. Task classification, one-shot success rate tracking,
retry cycle detection. Non-critical -- errors are logged and swallowed.

**Storage:** `{cacheDir}/analytics.db`

**Tables:**
- `turns` -- per-turn (timestamp, session_id, cwd, project_id INTEGER, model,
  tool_sequence, task_category, retry_count, one_shot, had_error, prompt_snippet)
- `tool_uses` -- per-tool-call (timestamp, session_id, tool_name)

**Task categories:** coding, debugging, refactoring, testing, exploration, git,
build, conversation, delegation, unknown. Classified deterministically from tool
use patterns + user prompt keywords.

**One-shot detection:** Counts edit-bash-edit retry cycles. `one_shot = 1` when
edits present, zero retries, and no error.

**Pipeline:** Hook events queue in memory per-session. On `Stop`/`StopFailure`,
the turn is classified and pushed to a batch queue. Flushed every 5s or 50 records.

**90-day retention.** Daily cleanup.

**API** (admin auth required):
- `GET /api/analytics/summary?period=7d&project=remote-claude`
- `GET /api/analytics/timeseries?period=7d&granularity=hour&project=remote-claude`
- `GET /api/analytics/models?period=7d&project=remote-claude`

All endpoints accept `?project=` (slug or integer ID) for per-project filtering.

**Mass import:** the old `scripts/import-analytics.ts` was deleted as dead code.
Historical-transcript backfill (FTS/transcripts, not analytics) now lives in the
agent host: `rclaude --rclaude-import-history --sentinel <alias>` -- see the
README CLI reference. Analytics turns are NOT retro-filled.

Files: `analytics-store.ts`

## Cost Reporting (SQLite)

Per-turn cost and token storage. Lives in the unified StoreDriver (not a
separate DB file as of Phase 4). `bun:sqlite` WAL mode. 30-day retention.

**Storage:** `{cacheDir}/store.db` (tables `turns` + `hourly_stats` alongside
the rest of the unified schema)

**Tables:**
- `turns` -- per-turn (timestamp, session, project_uri, account, model, tokens, cost, exact_cost)
- `hourly_stats` -- rollups by (hour, account, model, project_uri)

**Recording:**
- Headless: exact cost from `turn_cost` WS (`total_cost_usd`)
- PTY: estimated from tokens + LiteLLM pricing on `Stop` hook
- Both use `store.costs.recordTurnFromCumulatives()` (per-session snapshots,
  computes deltas)

**API** (admin auth required):
- `GET /api/stats/turns?from=&to=&account=&model=&project=&limit=&offset=`
- `GET /api/stats/hourly?from=&to=&groupBy=hour|day`
- `GET /api/stats/summary?period=24h|7d|30d`

`turn_recorded` WS broadcast after each insert.

**Migration from legacy `cost-data.db`:** `broker-cli migrate` absorbs any
pre-existing `cost-data.db` turns into the unified `store.db`. Idempotent:
re-running while the unified turns table is non-empty is a no-op with a
warning.

**Retention:** A 30-day prune runs daily from the broker's startup timer
(`index.ts`) via `store.costs.pruneOlderThan(cutoff)`.

**bun:sqlite gotcha:** `$name` in SQL -> key WITHOUT `$` in JS:
`db.prepare('WHERE x < $cutoff').run({ cutoff: 42 })`

Files: `store/sqlite/costs.ts`, `store/memory/driver.ts` (for tests),
`handlers/transcript.ts`, `session-store.ts`, `routes/stats.ts`, `store/migrate.ts`

## Model Pricing (LiteLLM)

Concentrator fetches `model_prices_and_context_window.json` from LiteLLM GitHub on
startup, caches to `{cacheDir}/litellm-pricing.json`, refreshes every 24h.
Only Claude models stored. Served via `GET /api/models`.

Dashboard: `contextWindowSize()` and `estimateCost()` with hardcoded fallback.
Files: `model-pricing.ts`, `web/src/lib/model-db.ts`, `web/src/lib/cost-utils.ts`

## Session Stats

`session.stats` accumulated from transcript entries and hook events:

- Tokens: totalInputTokens, totalOutputTokens, totalCacheCreation, totalCacheRead
- Activity: turnCount, toolCallCount, compactionCount
- Cost: totalCostUsd (exact for headless, undefined for PTY)
- Lines changed: linesAdded/linesRemoved (from Edit structuredPatch hunks, incremental only)
- API time: totalApiDurationMs (from system `turn_duration` entries)

## Plan Usage Tracking

sentinel polls `api.anthropic.com/api/oauth/usage` every 10 minutes using
OAuth token from macOS Keychain or `~/.claude/.credentials.json`. Only utilization
percentages forwarded -- credentials never leave host.

Dashboard: 5h/7d utilization bars in header. Per-model on desktop.
Green < 50%, amber < 75%, orange < 90%, red >= 90%.

Files: `src/sentinel/index.ts`, `handlers/sentinel.ts`, `usage-bar.tsx`

## Context Window Detection

`contextWindowSize()` resolves from LiteLLM DB (fetched by broker, served
via `GET /api/models`). Hardcoded fallback when DB not loaded.
