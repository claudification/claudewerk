import type { Database } from 'bun:sqlite'

export function createRecapSchema(db: Database) {
  createRecapsTable(db)
  createRecapLogsTable(db)
  createRecapChunksTable(db)
  createRecapTagsTable(db)
  createRecapsFtsTable(db)
  createRecapMapCacheTable(db)
}

/**
 * Cross-run MAP-stage cache: extraction JSON keyed on the CONTENT hash of one
 * conversation (see recap/period/chunk/map-cache.ts).
 *
 * Deliberately NOT tied to a recap id -- the whole point is surviving to the
 * next run. The nightly recap re-extracted ~6 of every 7 conversations from
 * scratch every night because the only reuse we had (the bundle) was scoped to
 * a single recapId; map was 69% of all recap spend. Rows are disposable: a miss
 * costs one map call, so the reaper prunes by last_used_at without ceremony.
 */
function createRecapMapCacheTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS recap_map_cache (
      key             TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      model           TEXT NOT NULL,
      metadata_json   TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      last_used_at    INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_recap_map_cache_used ON recap_map_cache(last_used_at)')
}

function createRecapsTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS recaps (
      id              TEXT PRIMARY KEY,
      project_uri     TEXT NOT NULL,
      period_label    TEXT NOT NULL,
      period_start    INTEGER NOT NULL,
      period_end      INTEGER NOT NULL,
      time_zone       TEXT NOT NULL,
      status          TEXT NOT NULL,
      progress        INTEGER NOT NULL DEFAULT 0,
      phase           TEXT,
      model           TEXT,
      input_chars     INTEGER NOT NULL DEFAULT 0,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      llm_cost_usd    REAL NOT NULL DEFAULT 0,
      markdown        TEXT,
      title           TEXT,
      subtitle        TEXT,
      error           TEXT,
      created_at      INTEGER NOT NULL,
      created_by      TEXT,
      started_at      INTEGER,
      completed_at    INTEGER,
      dismissed_at    INTEGER,
      signals_json    TEXT NOT NULL,
      signals_hash    TEXT NOT NULL,
      input_hash      TEXT,
      metadata_json   TEXT,
      digest_json     TEXT,
      audience        TEXT NOT NULL DEFAULT 'human',
      inform_conversation_id TEXT,
      ledger_json     TEXT,
      args_json       TEXT,
      failures_json   TEXT,
      resolution_json TEXT
    )
  `)
  // ALTER ADD COLUMN for upgrades from the pre-audience shape. SQLite ALTER
  // ADD COLUMN is idempotent only if guarded -- check the column list first.
  const recapCols = new Set(
    (db.prepare("PRAGMA table_info('recaps')").all() as Array<{ name: string }>).map(r => r.name),
  )
  if (!recapCols.has('audience')) {
    db.run("ALTER TABLE recaps ADD COLUMN audience TEXT NOT NULL DEFAULT 'human'")
  }
  if (!recapCols.has('inform_conversation_id')) {
    db.run('ALTER TABLE recaps ADD COLUMN inform_conversation_id TEXT')
  }
  // Recap 2.0: curated chart/drill-down projection (RecapDigest). Additive --
  // pre-2.0 rows keep digest_json NULL and degrade to the markdown body.
  if (!recapCols.has('digest_json')) {
    db.run('ALTER TABLE recaps ADD COLUMN digest_json TEXT')
  }
  // Chunked map-reduce spike: COST 2 per-call engine-cost ledger (Pillar C)
  // and the resolved tuning-param recipe (Pillar D). Both additive -- older
  // rows keep NULL and degrade to the aggregate llm_cost_usd / no recipe.
  if (!recapCols.has('ledger_json')) {
    db.run('ALTER TABLE recaps ADD COLUMN ledger_json TEXT')
  }
  if (!recapCols.has('args_json')) {
    db.run('ALTER TABLE recaps ADD COLUMN args_json TEXT')
  }
  // Salvage/resilience: per-chunk casualty records (RecapChunkFailure[]) for a
  // PARTIAL recap -- which conversations fell out and why. Additive; a recap
  // that predates it keeps NULL and shows only the legacy count in its reason.
  if (!recapCols.has('failures_json')) {
    db.run('ALTER TABLE recaps ADD COLUMN failures_json TEXT')
  }
  // What the reader decided about a PARTIAL recap (RecapResolution JSON). NULL
  // means nobody has looked at it yet -- which is NOT the same as accepting it.
  if (!recapCols.has('resolution_json')) {
    db.run('ALTER TABLE recaps ADD COLUMN resolution_json TEXT')
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_recaps_project ON recaps(project_uri, created_at DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_recaps_status ON recaps(status)')
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_recaps_active ON recaps(status) WHERE status IN ('queued','gathering','rendering')",
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_recaps_cache_lookup ON recaps(project_uri, period_start, period_end, signals_hash, status, completed_at)',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_recaps_input_hash ON recaps(input_hash) WHERE input_hash IS NOT NULL')
}

function createRecapLogsTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS recap_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      recap_id    TEXT NOT NULL,
      timestamp   INTEGER NOT NULL,
      level       TEXT NOT NULL,
      phase       TEXT NOT NULL,
      message     TEXT NOT NULL,
      data_json   TEXT
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_recap_logs_recap ON recap_logs(recap_id, timestamp)')
}

function createRecapChunksTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS recap_chunks (
      id            TEXT PRIMARY KEY,
      parent_id     TEXT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
      chunk_kind    TEXT NOT NULL,
      chunk_start   INTEGER NOT NULL,
      chunk_end     INTEGER NOT NULL,
      markdown      TEXT NOT NULL,
      input_chars   INTEGER NOT NULL,
      input_tokens  INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd      REAL NOT NULL DEFAULT 0,
      model         TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_recap_chunks_parent ON recap_chunks(parent_id, chunk_start)')
}

function createRecapTagsTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS recap_tags (
      recap_id  TEXT NOT NULL,
      tag       TEXT NOT NULL,
      kind      TEXT NOT NULL,
      PRIMARY KEY (recap_id, tag, kind)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_recap_tags_tag ON recap_tags(tag)')
  db.run('CREATE INDEX IF NOT EXISTS idx_recap_tags_kind_tag ON recap_tags(kind, tag)')
}

// No triggers -- explicit sync from app code on markRecapDone (json_extract
// can't join JSON arrays from metadata_json, so we do it in JS instead).
function createRecapsFtsTable(db: Database) {
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS recaps_fts USING fts5(
      recap_id UNINDEXED,
      project_uri UNINDEXED,
      title,
      subtitle,
      keywords,
      goals,
      discoveries,
      side_effects,
      body,
      tokenize = 'porter unicode61'
    )
  `)
}
