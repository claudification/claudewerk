/**
 * Lessons-Learned Scavenger -- TIER 2: compaction ("dream") + cross-project tech.
 *
 * The Tier-1 nightly scavenge over a fixed rolling-7d window produces heavily
 * OVERLAPPING recaps (night N covers [N-7,N]; night N+1 covers [N-6,N+1]). Left
 * alone, recaps_fts fills with ~7 near-duplicates of every lesson. Compaction is
 * the consolidation pass Jonas asked for:
 *
 *   1. FOLD each project's nightly lessons recaps into a single durable, deduped
 *      per-project LEDGER (a recap row, so it stays searchable + viewable).
 *   2. REAP the folded nightlies so search stays lean.
 *   3. The cross-project TECH REGISTRY is DERIVED ON QUERY from the ledgers'
 *      `tech_discovered` -- no separate table, always consistent with the ledgers.
 *
 * All LLM-FREE: it reuses the deterministic merge primitives (`mergeMetadata` +
 * `dedupItems`, which reconcile citations and tech `outcome`). Cost = zero tokens.
 * Rolling-7d makes the fold safe: the newest nightly is a superset of the prior
 * six, and weekly compaction (cadence <= window) leaves no coverage gap.
 *
 * Dependency-injected for unit testing; the broker wires the store concretions.
 */

import type { RecapItem, RecapMetadata } from '../shared/protocol'
import { dedupItems, mergeMetadata } from './recap/period/chunk/merge'

/** A completed lessons recap (nightly or ledger), reduced to what compaction needs. */
export interface LessonsRecapRecord {
  id: string
  completedAt: number
  metadata: RecapMetadata
}

export interface CompactionDeps {
  now: () => number
  log: (msg: string) => void
  listProjectUris: () => string[]
  isEnabled: (projectUri: string) => boolean
  /** Completed Tier-1 nightly lessons recaps for a project (createdBy=scavenger). */
  loadNightlies: (projectUri: string) => LessonsRecapRecord[]
  /** The project's existing durable ledger, if one was already written. */
  loadLedger: (projectUri: string) => LessonsRecapRecord | null
  /** Insert-or-update the project's ledger recap from the merged metadata. */
  saveLedger: (projectUri: string, metadata: RecapMetadata) => void
  /** Purge the folded nightly recap ids (row + FTS + tags). */
  reap: (recapIds: string[]) => void
}

export interface CompactionResult {
  projects: number
  compacted: number
  reaped: number
  skipped: number
}

/**
 * Run ONE compaction pass: for every opted-in project with un-folded nightlies,
 * fold {existing ledger} + {nightlies} -> updated ledger, then reap the
 * nightlies. Never throws: a project's failure is logged and the pass continues.
 */
export async function compactOnce(deps: CompactionDeps): Promise<CompactionResult> {
  const result: CompactionResult = { projects: 0, compacted: 0, reaped: 0, skipped: 0 }

  for (const projectUri of deps.listProjectUris()) {
    result.projects++
    if (!deps.isEnabled(projectUri)) {
      result.skipped++
      continue
    }
    const nightlies = deps.loadNightlies(projectUri)
    if (nightlies.length === 0) {
      result.skipped++
      continue
    }

    try {
      const ledger = deps.loadLedger(projectUri)
      const parts = [ledger?.metadata, ...nightlies.map(n => n.metadata)].filter((m): m is RecapMetadata => m != null)
      const merged = mergeLessonsMetadata(parts)
      deps.saveLedger(projectUri, merged)
      deps.reap(nightlies.map(n => n.id))
      result.compacted++
      result.reaped += nightlies.length
      deps.log(
        `[lessons] compacted ${shortUri(projectUri)}: folded ${nightlies.length} nightly recap(s) into the ledger`,
      )
    } catch (err) {
      deps.log(
        `[lessons] compaction FAILED ${shortUri(projectUri)}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  deps.log(
    `[lessons] compaction complete: ${result.compacted} ledgers updated, ${result.reaped} nightlies reaped, ` +
      `${result.skipped} skipped of ${result.projects} projects`,
  )
  return result
}

const DAY_MS = 24 * 60 * 60 * 1000

/** ms from `now` until the next local `weekday` (0=Sun..6=Sat) at `hour`:00.
 *  Always > 0 (if today is the weekday but the hour has passed, rolls a week). */
export function msUntilNextWeekday(weekday: number, hour: number, now: number): number {
  const d = new Date(now)
  d.setHours(hour, 0, 0, 0)
  let days = (weekday - d.getDay() + 7) % 7
  if (days === 0 && d.getTime() <= now) days = 7
  d.setDate(d.getDate() + days)
  return d.getTime() - now
}

/**
 * Start the weekly compaction: fire at the next `weekday`:`hour`, then every 7d.
 * No boot-run (a restart must not trigger work); compaction is LLM-free but still
 * mutates the store. Returns a stop() for teardown/tests.
 */
export function startLessonsCompaction(
  deps: CompactionDeps,
  opts: { hour?: number; weekday?: number } = {},
): () => void {
  const hour = opts.hour ?? 5 // 05:00, after the 04:00 nightly scavenge
  const weekday = opts.weekday ?? 0 // Sunday
  let interval: ReturnType<typeof setInterval> | null = null

  const tick = () => {
    compactOnce(deps).catch(err =>
      deps.log(`[lessons] compaction threw: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  const wait = msUntilNextWeekday(weekday, hour, deps.now())
  const timeout = setTimeout(() => {
    tick()
    interval = setInterval(tick, 7 * DAY_MS)
  }, wait)

  deps.log(`[lessons] compaction scheduled: first run in ${Math.round(wait / 3_600_000)}h, then weekly`)
  return () => {
    clearTimeout(timeout)
    if (interval) clearInterval(interval)
  }
}

/** The OPTIONAL RecapMetadata item fields the base mergeMetadata doesn't touch. */
const OPTIONAL_ITEM_FIELDS = ['tech_discovered', 'recommendations', 'went_well', 'went_badly'] as const

/**
 * Merge lessons metadata across recaps. `mergeMetadata` handles the base vocab +
 * string lists; this additionally folds the OPTIONAL item fields (tech_discovered
 * etc.) the base merge skips, so the ledger accumulates everything -- deduped,
 * with citations + tech outcomes reconciled.
 */
export function mergeLessonsMetadata(parts: RecapMetadata[]): RecapMetadata {
  const base = mergeMetadata(parts)
  for (const field of OPTIONAL_ITEM_FIELDS) {
    const items = dedupItems(parts.flatMap(p => (p[field] as RecapItem[] | undefined) ?? []))
    if (items.length) (base as unknown as Record<string, unknown>)[field] = items
  }
  return base
}

// ---------------------------------------------------------------------------
// Cross-project tech registry -- derived on query from the ledgers.
// ---------------------------------------------------------------------------

export interface TechUsage {
  project: string
  outcome?: RecapItem['outcome']
  detail?: string
  conversations: string[]
}

export interface TechRegistryEntry {
  tech: string
  usages: TechUsage[]
}

/**
 * Build the cross-project tech registry from the per-project ledgers: group every
 * `tech_discovered` item by normalized tech name, recording which projects used
 * it + the outcome there. This is the "we used X in project Y, and it worked /
 * didn't" signal -- ordered by breadth of adoption (most projects first).
 */
export function buildTechRegistry(
  ledgers: Array<{ projectUri: string; metadata: RecapMetadata }>,
): TechRegistryEntry[] {
  const byKey = new Map<string, TechRegistryEntry>()
  for (const { projectUri, metadata } of ledgers) {
    for (const item of metadata.tech_discovered ?? []) {
      const key = normTech(item.title)
      if (!key) continue
      let entry = byKey.get(key)
      if (!entry) {
        entry = { tech: item.title, usages: [] }
        byKey.set(key, entry)
      }
      entry.usages.push({
        project: shortUri(projectUri),
        outcome: item.outcome,
        detail: item.detail,
        conversations: item.conversations ?? [],
      })
    }
  }
  return [...byKey.values()].sort((a, b) => b.usages.length - a.usages.length || a.tech.localeCompare(b.tech))
}

/** Filter the registry to entries whose tech name matches `term` (substring,
 *  normalized). Empty term returns the whole registry. */
export function queryTech(registry: TechRegistryEntry[], term: string): TechRegistryEntry[] {
  const t = normTech(term)
  if (!t) return registry
  return registry.filter(e => normTech(e.tech).includes(t))
}

function normTech(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim()
}

function shortUri(uri: string): string {
  const m = uri.match(/[^/]+$/)
  return m ? m[0] : uri
}
