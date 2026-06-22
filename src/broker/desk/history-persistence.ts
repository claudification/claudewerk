/**
 * FILE/JSON persistence for the per-user dispatcher state (plan-dispatcher-
 * persistence.md Slice A). The dispatcher is the SOLE SOURCE OF TRUTH and must
 * SURVIVE a broker restart -- so both the LivingHistory (blocks + LLM window +
 * lastConsolidatedAt) AND the viewable transcript ring are serialized to one
 * JSON file per user under `<cacheDir>/dispatcher/<safe-userKey>.json`.
 *
 * Pure serialize/deserialize (unit-tested, no disk) + a debounced atomic saver
 * and a boot-time loader. All fs/clock/timer access is injectable so the saver's
 * debounce + atomic-rename can be driven by a virtual clock in tests.
 *
 * Keyed by a SAFE-ENCODED userKey, NEVER a filesystem path (NAMING covenant) --
 * the userKey is also stored INSIDE the JSON, so the load never trusts the
 * filename for identity.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHistory, type LivingHistory, type Role, type Turn, upsertBlock } from './living-history'

const SCHEMA_VERSION = 1
const DEFAULT_DEBOUNCE_MS = 1500
const SUBDIR = 'dispatcher'

/** The full restart-survivable state for one user's dispatcher. */
export interface PersistableState {
  userKey: string
  history: LivingHistory
  lastConsolidatedAt: number | null
  transcript: Turn[]
}

const asRole = (r: unknown): Role => (r === 'assistant' ? 'assistant' : 'user')
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')
const asNum = (v: unknown): number => (typeof v === 'number' ? v : 0)
const asTurn = (t: { role?: unknown; content?: unknown; ts?: unknown }): Turn => ({
  kind: 'turn',
  role: asRole(t.role),
  content: asStr(t.content),
  ts: asNum(t.ts),
})

type RawBlock = { id?: unknown; tag?: unknown; content?: unknown; ts?: unknown }

/** Rebuild the addressable blocks Map (insertion order preserved) from raw JSON,
 *  skipping any entry without a string id+tag. */
function rehydrateBlocks(history: LivingHistory, blocks: RawBlock[] | undefined): void {
  for (const b of blocks ?? []) {
    if (typeof b.id === 'string' && typeof b.tag === 'string') {
      upsertBlock(history, b.id, b.tag, asStr(b.content), asNum(b.ts))
    }
  }
}

/** Serialize a user's state to JSON (Map -> array for blocks; turns/transcript as-is). */
export function serializeHistory(s: PersistableState): string {
  return JSON.stringify({
    v: SCHEMA_VERSION,
    userKey: s.userKey,
    lastConsolidatedAt: s.lastConsolidatedAt,
    blocks: [...s.history.blocks.values()].map(b => ({ id: b.id, tag: b.tag, content: b.content, ts: b.ts })),
    turns: s.history.turns.map(t => ({ role: t.role, content: t.content, ts: t.ts })),
    transcript: s.transcript.map(t => ({ role: t.role, content: t.content, ts: t.ts })),
  })
}

/** Parse a persisted JSON back into a PersistableState. Throws on malformed JSON
 *  or a missing userKey -- the caller (loadAll) skips a corrupt file. */
export function deserializeHistory(json: string): PersistableState {
  const raw = JSON.parse(json) as {
    userKey?: unknown
    lastConsolidatedAt?: unknown
    blocks?: RawBlock[]
    turns?: Array<Record<string, unknown>>
    transcript?: Array<Record<string, unknown>>
  }
  if (typeof raw.userKey !== 'string' || !raw.userKey) throw new Error('persisted history missing userKey')
  const history = createHistory()
  rehydrateBlocks(history, raw.blocks)
  history.turns = (raw.turns ?? []).map(asTurn)
  return {
    userKey: raw.userKey,
    history,
    lastConsolidatedAt: typeof raw.lastConsolidatedAt === 'number' ? raw.lastConsolidatedAt : null,
    transcript: (raw.transcript ?? []).map(asTurn),
  }
}

/** Filesystem-safe filename for a userKey (base64url -- reversible + path-free). */
export function fileNameForKey(userKey: string): string {
  return `${Buffer.from(userKey, 'utf8').toString('base64url')}.json`
}

/** Injectable seams so the debounce + atomic write are testable without real disk. */
export interface PersistenceDeps {
  readdir?(dir: string): string[]
  readFile?(path: string): string
  writeFile?(path: string, data: string): void
  rename?(from: string, to: string): void
  remove?(path: string): void
  ensureDir?(dir: string): void
  now?(): number
  schedule?(fn: () => void, ms: number): unknown
  cancel?(handle: unknown): void
  debounceMs?: number
}

const defaultDeps: Required<Omit<PersistenceDeps, 'debounceMs'>> = {
  readdir: dir => readdirSync(dir),
  readFile: path => readFileSync(path, 'utf8'),
  writeFile: (path, data) => writeFileSync(path, data),
  rename: (from, to) => renameSync(from, to),
  remove: path => rmSync(path, { force: true }),
  ensureDir: dir => mkdirSync(dir, { recursive: true }),
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Read every persisted history under `<dir>/dispatcher/`. Tolerates a missing
 *  dir / corrupt files (skip + log, never crash) so a bad file can't sink boot. */
export function loadAllHistories(dir: string, deps: PersistenceDeps = {}): Map<string, PersistableState> {
  const d = { ...defaultDeps, ...deps }
  const out = new Map<string, PersistableState>()
  const base = join(dir, SUBDIR)
  let names: string[]
  try {
    names = d.readdir(base)
  } catch {
    return out // no dir yet -- nothing persisted
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const state = deserializeHistory(d.readFile(join(base, name)))
      out.set(state.userKey, state)
    } catch (e) {
      console.warn(`[dispatcher] skipping corrupt history ${name}: ${(e as Error).message}`)
    }
  }
  return out
}

/** A debounced, atomic, per-user saver. `scheduleSave` coalesces rapid mutations
 *  into one write ~debounceMs later; the write goes to a tmp file then renames
 *  (atomic). `removeFile` cancels any pending write and deletes the file. */
export interface HistorySaver {
  scheduleSave(userKey: string, getState: () => PersistableState): void
  removeFile(userKey: string): void
}

export function createHistorySaver(dir: string, deps: PersistenceDeps = {}): HistorySaver {
  const d = { ...defaultDeps, ...deps }
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const base = join(dir, SUBDIR)
  const timers = new Map<string, unknown>()
  let dirReady = false

  const ensureBase = () => {
    if (dirReady) return
    d.ensureDir(base)
    dirReady = true
  }
  const writeNow = (userKey: string, getState: () => PersistableState) => {
    timers.delete(userKey)
    try {
      ensureBase()
      const file = join(base, fileNameForKey(userKey))
      const tmp = `${file}.${d.now()}.tmp`
      d.writeFile(tmp, serializeHistory(getState()))
      d.rename(tmp, file)
    } catch (e) {
      console.warn(`[dispatcher] failed to persist history for ${userKey}: ${(e as Error).message}`)
    }
  }

  return {
    scheduleSave(userKey, getState) {
      const existing = timers.get(userKey)
      if (existing !== undefined) d.cancel(existing)
      timers.set(
        userKey,
        d.schedule(() => writeNow(userKey, getState), debounceMs),
      )
    },
    removeFile(userKey) {
      const existing = timers.get(userKey)
      if (existing !== undefined) {
        d.cancel(existing)
        timers.delete(userKey)
      }
      try {
        d.remove(join(base, fileNameForKey(userKey)))
      } catch {
        /* already gone */
      }
    },
  }
}
