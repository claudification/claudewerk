import type { Database } from 'bun:sqlite'
import { migrateFormerSlugs } from './migrate-former-slugs'
import { migrateParentColumns } from './migrate-parent-columns'
import { createRecapSchema } from './recap-schema'

function tableColumns(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(r => r.name))
}

/** Phase 5 (sentinel profiles): backfill sentinel_id + profile columns on the
 *  cost tables. Idempotent ALTER ADD COLUMN -- the columns gain defaults so
 *  pre-existing rows bucket cleanly under sentinelId='' / profile='default'. */
function addPhase5ProfileColumns(db: Database): void {
  const turnCols = tableColumns(db, 'turns')
  if (!turnCols.has('sentinel_id')) db.run("ALTER TABLE turns ADD COLUMN sentinel_id TEXT NOT NULL DEFAULT ''")
  if (!turnCols.has('profile')) db.run("ALTER TABLE turns ADD COLUMN profile TEXT NOT NULL DEFAULT 'default'")
  const hourlyCols = tableColumns(db, 'hourly_stats')
  if (!hourlyCols.has('sentinel_id')) db.run("ALTER TABLE hourly_stats ADD COLUMN sentinel_id TEXT NOT NULL DEFAULT ''")
  if (!hourlyCols.has('profile')) db.run("ALTER TABLE hourly_stats ADD COLUMN profile TEXT NOT NULL DEFAULT 'default'")
}

/** cache-ttl split: backfill the 5m/1h cache-write columns on token_samples.
 *  Idempotent ALTER ADD COLUMN; pre-existing rows keep 0 (the collapsed total
 *  can't be un-mixed, so we don't guess it -- new samples carry the real split). */
function addCacheTtlColumns(db: Database): void {
  const cols = tableColumns(db, 'token_samples')
  if (!cols.has('cache_write_5m_tokens'))
    db.run('ALTER TABLE token_samples ADD COLUMN cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0')
  if (!cols.has('cache_write_1h_tokens'))
    db.run('ALTER TABLE token_samples ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0')
}

/** profile-url-strip migration (2026-05-22): the URI format dropped its
 *  `profile@host` userinfo. Cost-table `project_uri` rows persisted from before
 *  this change still carry the userinfo. Rewrite to canonical form once.
 *
 *  Iterates rows in JS (bun:sqlite supports prepared transactions). Idempotent
 *  -- re-runs are no-ops because the rewriter is identity on canonical URIs. */
function stripProfileFromUri(uri: string): string {
  const schemeMatch = uri.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i)
  if (!schemeMatch) return uri
  const prefix = schemeMatch[1]
  const rest = schemeMatch[2]
  const authorityEndIdx = rest.search(/[/#]/)
  const authority = authorityEndIdx >= 0 ? rest.slice(0, authorityEndIdx) : rest
  const tail = authorityEndIdx >= 0 ? rest.slice(authorityEndIdx) : ''
  const atIdx = authority.indexOf('@')
  if (atIdx < 0) return uri
  return `${prefix}${authority.slice(atIdx + 1)}${tail}`
}

// fallow-ignore-next-line complexity
function stripProfileFromCostTableUris(db: Database): void {
  for (const table of ['turns', 'hourly_stats'] as const) {
    const rows = db
      .prepare(`SELECT DISTINCT project_uri AS uri FROM ${table} WHERE project_uri LIKE '%@%'`)
      .all() as Array<{ uri: string }>
    if (rows.length === 0) continue
    const update = db.prepare(`UPDATE ${table} SET project_uri = $next WHERE project_uri = $prev`)
    db.run('BEGIN')
    try {
      let touched = 0
      for (const row of rows) {
        const next = stripProfileFromUri(row.uri)
        if (next !== row.uri) {
          update.run({ prev: row.uri, next })
          touched++
        }
      }
      db.run('COMMIT')
      if (touched > 0) {
        console.log(`[profile-url-strip] rewrote ${touched} distinct ${table}.project_uri row(s) to canonical form`)
      }
    } catch (err) {
      db.run('ROLLBACK')
      throw err
    }
  }
}

/** profile-url-strip migration: rewrite `conversations.scope` rows that still
 *  carry `profile@host` userinfo, AND backfill `meta.resolvedProfile` from the
 *  extracted name (the conversation's pinned profile lives in the typed
 *  Conversation.resolvedProfile field now, NOT in the URI). Idempotent. */
// fallow-ignore-next-line complexity
function stripProfileFromConversationScopes(db: Database): void {
  const rows = db.prepare(`SELECT id, scope, meta FROM conversations WHERE scope LIKE '%@%'`).all() as Array<{
    id: string
    scope: string
    meta: string | null
  }>
  if (rows.length === 0) return
  const update = db.prepare(`UPDATE conversations SET scope = $scope, meta = $meta WHERE id = $id`)
  db.run('BEGIN')
  try {
    let touched = 0
    for (const row of rows) {
      const nextScope = stripProfileFromUri(row.scope)
      if (nextScope === row.scope) continue
      // Extract profile name from the legacy URI for the backfill.
      const userinfoMatch = row.scope.match(/^[a-z][a-z0-9+.-]*:\/\/([^/#@]+)@/i)
      const profileName = userinfoMatch ? userinfoMatch[1] : undefined
      let meta: Record<string, unknown> = {}
      if (row.meta) {
        try {
          meta = JSON.parse(row.meta) as Record<string, unknown>
        } catch {
          // Malformed meta -- preserve the row's scope rewrite, leave meta untouched.
          update.run({ id: row.id, scope: nextScope, meta: row.meta })
          touched++
          continue
        }
      }
      if (profileName && profileName !== 'default' && !meta.resolvedProfile) {
        meta.resolvedProfile = profileName
      }
      update.run({ id: row.id, scope: nextScope, meta: JSON.stringify(meta) })
      touched++
    }
    db.run('COMMIT')
    if (touched > 0) {
      console.log(
        `[profile-url-strip] rewrote ${touched} conversation scope row(s) to canonical form + backfilled resolvedProfile`,
      )
    }
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  }
}

export function createSchema(db: Database) {
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA synchronous = NORMAL')

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      agent_version TEXT,
      title TEXT,
      summary TEXT,
      label TEXT,
      icon TEXT,
      color TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      model TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_activity INTEGER,
      meta TEXT,
      stats TEXT
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_conversations_scope ON conversations(scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status)')
  db.run('CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at)')

  // Phase 2 spawn-parent-tracking: add parent_conversation_id +
  // root_conversation_id (NULL = unrooted / human-started). Idempotent.
  migrateParentColumns(db)

  // conversation-rename Phase 2: add former_slugs (JSON alias-decay history).
  // Idempotent.
  migrateFormerSlugs(db)

  db.run(`
    CREATE TABLE IF NOT EXISTS transcript_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      sync_epoch TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      agent_id TEXT,
      uuid TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      UNIQUE(conversation_id, uuid)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_conversation ON transcript_entries(conversation_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_conversation_seq ON transcript_entries(conversation_id, seq)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_transcript_conversation_agent ON transcript_entries(conversation_id, agent_id)',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_timestamp ON transcript_entries(timestamp)')
  // Render order is (timestamp, seq) -- see CHRONO_ASC in sqlite/transcripts.ts.
  // Without this every transcript read sorts on the heap; with it getLatest,
  // getSinceSeq, getBeforeSeq and getWindow all walk the index directly.
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_transcript_conversation_chrono ON transcript_entries(conversation_id, timestamp, seq)',
  )

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
      content,
      content=transcript_entries,
      content_rowid=id,
      tokenize='porter unicode61'
    )
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS transcript_fts_ai AFTER INSERT ON transcript_entries BEGIN
      INSERT INTO transcript_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS transcript_fts_ad AFTER DELETE ON transcript_entries BEGIN
      INSERT INTO transcript_fts(transcript_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS transcript_fts_au AFTER UPDATE ON transcript_entries BEGIN
      INSERT INTO transcript_fts(transcript_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO transcript_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)

  // Backfill: if FTS index is empty but transcript_entries has data, rebuild.
  // Uses transcript_fts_docsize (one row per indexed doc) as the emptiness probe.
  const indexed = db.prepare('SELECT COUNT(*) AS cnt FROM transcript_fts_docsize').get() as { cnt: number }
  const tx = db.prepare('SELECT COUNT(*) AS cnt FROM transcript_entries').get() as { cnt: number }
  if (indexed.cnt === 0 && tx.cnt > 0) {
    const start = Date.now()
    db.run("INSERT INTO transcript_fts(transcript_fts) VALUES('rebuild')")
    const ms = Date.now() - start
    console.error(
      `[fts] backfilled ${tx.cnt} transcript entries in ${ms}ms (${Math.round(tx.cnt / Math.max(ms, 1))} entries/ms)`,
    )
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_events_conversation_type ON events(conversation_id, type)')

  db.run(`
    CREATE TABLE IF NOT EXISTS scope_links (
      scope_a TEXT NOT NULL,
      scope_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(scope_a, scope_b)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_scope_links_a ON scope_links(scope_a)')
  db.run('CREATE INDEX IF NOT EXISTS idx_scope_links_b ON scope_links(scope_b)')

  db.run(`
    CREATE TABLE IF NOT EXISTS address_book (
      owner_scope TEXT NOT NULL,
      slug TEXT NOT NULL,
      target_scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used INTEGER,
      PRIMARY KEY(owner_scope, slug)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_address_book_target ON address_book(target_scope)')

  db.run(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_scope TEXT NOT NULL,
      to_scope TEXT NOT NULL,
      from_conversation_id TEXT,
      from_name TEXT,
      target_name TEXT,
      content TEXT NOT NULL,
      intent TEXT,
      conversation_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_message_queue_to ON message_queue(to_scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_message_queue_expires ON message_queue(expires_at)')

  db.run(`
    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_scope TEXT NOT NULL,
      to_scope TEXT NOT NULL,
      from_conversation_id TEXT,
      to_conversation_id TEXT,
      from_name TEXT,
      to_name TEXT,
      content TEXT,
      intent TEXT,
      conversation_id TEXT,
      full_length INTEGER,
      created_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_message_log_from ON message_log(from_scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_message_log_to ON message_log(to_scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_message_log_conv ON message_log(conversation_id)')

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      name TEXT,
      description TEXT,
      priority INTEGER,
      order_index INTEGER,
      blocked_by TEXT,
      blocks TEXT,
      owner TEXT,
      data TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      completed_at INTEGER,
      archived_at INTEGER,
      PRIMARY KEY(conversation_id, id)
    )
  `)
  // ALTER ADD COLUMN for upgrades from the v0 shape (id/conv/kind/status/name/data/created_at/updated_at).
  // SQLite ALTER ADD COLUMN is idempotent only if you guard it -- check column list first.
  const taskCols = new Set((db.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>).map(r => r.name))
  for (const [col, ddl] of [
    ['description', 'description TEXT'],
    ['priority', 'priority INTEGER'],
    ['order_index', 'order_index INTEGER'],
    ['blocked_by', 'blocked_by TEXT'],
    ['blocks', 'blocks TEXT'],
    ['owner', 'owner TEXT'],
    ['completed_at', 'completed_at INTEGER'],
    ['archived_at', 'archived_at INTEGER'],
  ] as const) {
    if (!taskCols.has(col)) db.run(`ALTER TABLE tasks ADD COLUMN ${ddl}`)
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_conversation_kind ON tasks(conversation_id, kind)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_conversation_active ON tasks(conversation_id) WHERE archived_at IS NULL')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at) WHERE archived_at IS NOT NULL')

  db.run(`
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      permissions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      viewer_count INTEGER NOT NULL DEFAULT 0
    )
  `)
  // v5: polymorphic share targets. Existing rows = conversation shares; new
  // rows can target other artifacts (e.g. recaps). The legacy conversation_id
  // column stays for one release cycle so old broker builds reading the row
  // still work; future writers populate both.
  const shareCols = new Set(
    (db.prepare("PRAGMA table_info('shares')").all() as Array<{ name: string }>).map(r => r.name),
  )
  if (!shareCols.has('target_kind')) {
    db.run("ALTER TABLE shares ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'conversation'")
  }
  if (!shareCols.has('target_id')) {
    db.run("ALTER TABLE shares ADD COLUMN target_id TEXT NOT NULL DEFAULT ''")
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_shares_conversation ON shares(conversation_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at)')
  db.run('CREATE INDEX IF NOT EXISTS idx_shares_target ON shares(target_kind, target_id)')

  createRecapSchema(db)

  db.run(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      project_uri TEXT NOT NULL DEFAULT '',
      account TEXT NOT NULL DEFAULT '',
      org_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      exact_cost INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS hourly_stats (
      hour TEXT NOT NULL,
      account TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      project_uri TEXT NOT NULL DEFAULT '',
      turn_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, account, model, project_uri)
    )
  `)
  // Phase 5 (sentinel profiles): denormalised (sentinel_id, profile) columns on
  // the cost tables. Since the URI no longer encodes profile (Phase 6 strip),
  // the `profile` column is the authoritative per-row profile name. The broker
  // stores NAMES only -- never configDir or env (Profile-Env Boundary).
  addPhase5ProfileColumns(db)
  // profile-url-strip (2026-05-22): rewrite any pre-existing `profile@host`
  // project_uri rows to canonical form, AND backfill conversation.resolvedProfile
  // from the extracted name. Idempotent.
  stripProfileFromCostTableUris(db)
  stripProfileFromConversationScopes(db)

  db.run('CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp)')
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_account ON turns(account)')
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_project_uri ON turns(project_uri)')
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_sentinel_profile ON turns(sentinel_id, profile)')

  db.run('CREATE INDEX IF NOT EXISTS idx_hourly_hour ON hourly_stats(hour)')
  db.run('CREATE INDEX IF NOT EXISTS idx_hourly_project_uri ON hourly_stats(project_uri)')
  db.run('CREATE INDEX IF NOT EXISTS idx_hourly_sentinel_profile ON hourly_stats(sentinel_id, profile)')

  // Per-MESSAGE raw token usage time-series (powers the live token-flow widget).
  // Distinct from `turns` (per-TURN delta-of-cumulative cost rollup): each
  // assistant API response carries its own `usage` block, so one row per
  // assistant message gives near-continuous fleet-level resolution. Values are
  // raw per-message usage (NOT cumulative -- the Anthropic API bills each
  // request independently). De-dup key is (conversation_id, uuid): transcript
  // re-reads on reconnect/restart (isInitial) AND the Phase-3 backfill from
  // transcript_entries both INSERT OR IGNORE, so they never double-count.
  db.run(`
    CREATE TABLE IF NOT EXISTS token_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      sentinel_id TEXT NOT NULL DEFAULT '',
      profile TEXT NOT NULL DEFAULT 'default',
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
      UNIQUE(conversation_id, uuid)
    )
  `)
  // cache-ttl split (2026-07-08): record the REAL 5m/1h portions of
  // cache_write_tokens per message so a cache-write-TTL time-series is KNOWN,
  // not reconstructed. Idempotent ADD COLUMN for DBs that predate it -- old rows
  // keep 0/0 (the split is unrecoverable from the collapsed total).
  addCacheTtlColumns(db)
  db.run('CREATE INDEX IF NOT EXISTS idx_token_samples_timestamp ON token_samples(timestamp)')
  db.run('CREATE INDEX IF NOT EXISTS idx_token_samples_profile_ts ON token_samples(sentinel_id, profile, timestamp)')
  db.run('CREATE INDEX IF NOT EXISTS idx_token_samples_conv_ts ON token_samples(conversation_id, timestamp)')
}
