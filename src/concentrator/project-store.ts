/**
 * Project Store -- SQLite-backed project registry.
 *
 * Provides stable integer IDs for projects, replacing repeated CWD/scope
 * strings across analytics, cost, and session stores. The projects table
 * is the single source of truth for project identity.
 *
 * Storage: {cacheDir}/projects.db (separate from analytics/cost -- this is
 * authoritative config, not disposable time-series data).
 *
 * ## Scope URI scheme (future-facing)
 *
 * ```
 * {provider}://{address}#{session}
 * ```
 *
 * - provider: claude, fabric, agent, api, ephemeral, ...
 * - address: host/path or opaque ID. Some providers have hosts, some don't.
 * - session fragment: optional, not all providers support sessions
 *
 * Examples:
 * ```
 * claude://my-machine/Users/jonas/projects/remote-claude#a1b2c3d4
 * claude:///Users/jonas/projects/remote-claude          (local, no host)
 * fabric://pipeline/data-etl-nightly
 * agent://openai/asst_abc123
 * ephemeral://uuid-here
 * ```
 *
 * The `scope` column stores the full URI. The `cwd` column is the raw
 * filesystem path (Claude Code specific). Both are indexed for lookup.
 * Integer `id` is what every other table references.
 */

import { Database, type Statement } from 'bun:sqlite'
import { resolve } from 'node:path'

// ─── Types ──────────────────────────────────────────────────────────

export interface Project {
  id: number
  cwd: string
  scope: string
  slug: string
  label: string | null
}

// ─── Module State ───────────────────────────────────────────────────

let db: Database | null = null
let stmtInsert: Statement | null = null
let stmtByCwd: Statement | null = null
let stmtByScope: Statement | null = null
let stmtById: Statement | null = null
let stmtBySlug: Statement | null = null
let stmtUpdateLabel: Statement | null = null
let stmtUpdateScope: Statement | null = null

/** In-memory cache: cwd -> Project (hot path, avoids DB hit on every hook event) */
const cwdCache = new Map<string, Project>()

// ─── Slug derivation ────────────────────────────────────────────────

/** Derive a URL-safe slug from a cwd path (last segment, lowercased) */
export function slugFromCwd(cwd: string): string {
  if (!cwd) return 'unknown'
  const segments = cwd.replace(/\/+$/, '').split('/')
  const last = segments[segments.length - 1]
  return (last || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

/** Derive a scope URI from a cwd path (Claude Code default) */
export function scopeFromCwd(cwd: string): string {
  if (!cwd) return 'claude:///'
  return `claude://${cwd}`
}

// ─── Init ───────────────────────────────────────────────────────────

export function initProjectStore(cacheDir: string): void {
  const dbPath = resolve(cacheDir, 'projects.db')
  db = new Database(dbPath, { strict: true })

  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA cache_size = -2000') // 2MB -- small table

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cwd TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL,
      label TEXT
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)')

  stmtInsert = db.prepare(`
    INSERT INTO projects (cwd, scope, slug, label) VALUES ($cwd, $scope, $slug, $label)
  `)
  stmtByCwd = db.prepare('SELECT id, cwd, scope, slug, label FROM projects WHERE cwd = $cwd')
  stmtByScope = db.prepare('SELECT id, cwd, scope, slug, label FROM projects WHERE scope = $scope')
  stmtById = db.prepare('SELECT id, cwd, scope, slug, label FROM projects WHERE id = $id')
  stmtBySlug = db.prepare('SELECT id, cwd, scope, slug, label FROM projects WHERE slug = $slug')
  stmtUpdateLabel = db.prepare('UPDATE projects SET label = $label WHERE id = $id')
  stmtUpdateScope = db.prepare('UPDATE projects SET scope = $scope WHERE id = $id')

  const count = (db.query('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n
  console.log(`[projects] Store initialized: ${dbPath} (${count} projects)`)
}

// ─── Lookup / Create ────────────────────────────────────────────────

/**
 * Get or create a project by CWD. This is the primary entry point --
 * called on every hook event to resolve cwd -> integer project_id.
 *
 * Uses in-memory cache for the hot path. Cache miss -> DB lookup -> DB insert.
 */
export function getOrCreateProject(cwd: string, label?: string): Project {
  // Hot path: cache hit
  const cached = cwdCache.get(cwd)
  if (cached) {
    // Update label if it changed (project-settings rename)
    if (label && label !== cached.label) {
      cached.label = label
      stmtUpdateLabel?.run({ label, id: cached.id })
    }
    return cached
  }

  // Cache miss: check DB
  const existing = stmtByCwd?.get({ cwd }) as Project | undefined
  if (existing) {
    if (label && label !== existing.label) {
      existing.label = label
      stmtUpdateLabel?.run({ label, id: existing.id })
    }
    cwdCache.set(cwd, existing)
    return existing
  }

  // Not in DB: create
  const slug = slugFromCwd(cwd)
  const scope = scopeFromCwd(cwd)
  stmtInsert?.run({ cwd, scope, slug, label: label || null })

  // Re-fetch to get the auto-assigned id
  const created = stmtByCwd?.get({ cwd }) as Project
  cwdCache.set(cwd, created)
  return created
}

/** Lookup by integer ID (for display/API) */
export function getProjectById(id: number): Project | null {
  return (stmtById?.get({ id }) as Project) || null
}

/** Lookup by slug (for API filtering: ?project=remote-claude) */
export function getProjectBySlug(slug: string): Project | null {
  return (stmtBySlug?.get({ slug }) as Project) || null
}

/** Lookup by scope URI */
export function getProjectByScope(scope: string): Project | null {
  return (stmtByScope?.get({ scope }) as Project) || null
}

/** List all projects (for admin UI, dashboards) */
export function listProjects(): Project[] {
  if (!db) return []
  return db.query('SELECT id, cwd, scope, slug, label FROM projects ORDER BY id').all() as Project[]
}

/** Update the scope URI for a project (for future migration to custom URIs) */
export function updateProjectScope(id: number, scope: string): void {
  stmtUpdateScope?.run({ scope, id })
  // Invalidate cache entry if present
  for (const [, p] of cwdCache) {
    if (p.id === id) {
      p.scope = scope
      break
    }
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────

export function closeProjectStore(): void {
  if (db) {
    try {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
    } catch (err) {
      console.error('[projects] Error closing database:', err)
    }
    db = null
    stmtInsert = null
    stmtByCwd = null
    stmtByScope = null
    stmtById = null
    stmtBySlug = null
    stmtUpdateLabel = null
    stmtUpdateScope = null
    cwdCache.clear()
  }
}
