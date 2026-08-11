/**
 * Legacy lane compatibility -- reading (and draining) boards that still keep
 * cards in `.rclaude/project/<status>/<id>.md`.
 *
 * Two migration paths, deliberately both:
 *   1. `scripts/board-upgrade.ts` -- the explicit sweep you run per project.
 *   2. LAZY, here -- any WRITE touching a card that still sits in a lane moves
 *      it into `cards/` first. A project that never runs the script still
 *      self-heals card by card, and nothing is ever written into a lane again.
 *
 * Reads are non-destructive: a read-only checkout still lists its whole board.
 *
 * COLLISION RULE: the same id in two lanes is ambiguous, so we pick the one
 * furthest along the pipeline (archived > done > in-review > in-progress >
 * open > inbox) and the upgrade script reports the losers loudly rather than
 * silently dropping them.
 */

import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cardPath, legacyLaneDir } from './project-paths'
import { TASK_STATUSES, type TaskStatus } from './task-statuses'

/** Later = wins a same-id collision across lanes. */
const PIPELINE_ORDER: readonly TaskStatus[] = ['inbox', 'open', 'in-progress', 'in-review', 'done', 'archived']

function pipelineRank(status: TaskStatus): number {
  const i = PIPELINE_ORDER.indexOf(status)
  return i === -1 ? -1 : i
}

export interface LegacyCard {
  slug: string
  /** The lane directory it was found in -- authoritative for its status. */
  status: TaskStatus
  abs: string
  mtime: number
}

/** `.md` files directly in a lane directory. Empty if the lane is absent --
 *  the normal case on a migrated board. */
function laneCards(root: string, status: TaskStatus): LegacyCard[] {
  let files: string[]
  try {
    files = readdirSync(legacyLaneDir(root, status))
  } catch {
    return []
  }
  const out: LegacyCard[] = []
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const abs = join(legacyLaneDir(root, status), file)
    try {
      const st = statSync(abs)
      if (st.isFile()) out.push({ slug: file.slice(0, -3), status, abs, mtime: st.mtimeMs })
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out
}

/** Every card still living in a lane directory, best-lane-wins per id. */
export function listLegacyCards(root: string): LegacyCard[] {
  const best = new Map<string, LegacyCard>()
  for (const status of TASK_STATUSES) {
    for (const card of laneCards(root, status)) {
      const prior = best.get(card.slug)
      if (!prior || pipelineRank(card.status) > pipelineRank(prior.status)) best.set(card.slug, card)
    }
  }
  return [...best.values()]
}

/** Every same-id collision across lanes, for the upgrade script's report. */
export function listLegacyCollisions(root: string): { slug: string; lanes: TaskStatus[] }[] {
  const seen = new Map<string, TaskStatus[]>()
  for (const status of TASK_STATUSES) {
    for (const card of laneCards(root, status)) {
      seen.set(card.slug, [...(seen.get(card.slug) ?? []), status])
    }
  }
  return [...seen.entries()].filter(([, lanes]) => lanes.length > 1).map(([slug, lanes]) => ({ slug, lanes }))
}

/** Locate one card in the lanes (best lane wins), or null if it isn't there. */
export function findLegacyCard(root: string, id: string): LegacyCard | null {
  let best: LegacyCard | null = null
  for (const status of TASK_STATUSES) {
    const abs = join(legacyLaneDir(root, status), `${id}.md`)
    try {
      if (!statSync(abs).isFile()) continue
    } catch {
      continue
    }
    if (!best || pipelineRank(status) > pipelineRank(best.status)) {
      best = { slug: id, status, abs, mtime: statSync(abs).mtimeMs }
    }
  }
  return best
}

/** True when any lane directory still holds a card -- drives the "run the
 *  upgrade" nudge in `project_list`. */
export function hasLegacyCards(root: string): boolean {
  for (const status of TASK_STATUSES) {
    try {
      if (readdirSync(legacyLaneDir(root, status)).some(f => f.endsWith('.md'))) return true
    } catch {
      /* lane absent */
    }
  }
  return false
}

/**
 * Move one lane-resident card into `cards/`, preserving its mtime. Does NOT
 * touch content -- the caller writes `status:` as part of the write it was
 * already doing, so this stays a pure relocation.
 *
 * Refuses if a canonical card already exists (the canonical copy always wins);
 * returns false so the caller can proceed against the canonical file.
 */
export function relocateLegacyCard(root: string, card: LegacyCard): boolean {
  const dest = cardPath(root, card.slug)
  if (existsSync(dest)) return false
  try {
    renameSync(card.abs, dest)
    return true
  } catch {
    return false
  }
}
