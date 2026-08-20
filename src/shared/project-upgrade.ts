/**
 * The board upgrade sweep: drain legacy lane folders into the canonical card
 * store, once, for a whole project.
 *
 *   .rclaude/project/<status>/<id>.md  ->  .rclaude/project/cards/<id>.md
 *                                          + `status: <status>` frontmatter
 *
 * Nothing depends on this having been run -- the store reads legacy lanes and
 * migrates them lazily on write (project-legacy.ts). This is the sweep that
 * gets it over with in one go, plus the loud report of anything ambiguous.
 *
 * Lives in `shared` rather than in the script so it is testable and so the same
 * code can be called from anywhere that wants to self-heal a board.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from './frontmatter'
import { serializeCard } from './project-card-file'
import { type LegacyCard, listLegacyCards, listLegacyCollisions } from './project-legacy'
import { boardRoot, cardPath, cardsDir, legacyLaneDir } from './project-paths'
import { TASK_STATUSES } from './task-statuses'

export interface UpgradeOptions {
  /** Report only -- touch nothing. */
  dryRun?: boolean
  /** Copy every lane file aside before moving anything (default true). */
  backup?: boolean
  /** Injected so the caller owns the clock (and tests stay deterministic). */
  nowMs?: number
}

export interface UpgradeReport {
  board: string
  /** Board absent -- nothing was done. */
  noBoard: boolean
  /** Cards found sitting in legacy lane folders. */
  legacy: LegacyCard[]
  /** Same id in more than one lane; the LAST lane listed is the one kept. */
  collisions: { slug: string; lanes: string[] }[]
  /** Where the pre-move copy went, if one was taken. */
  backupDir?: string
  backedUp: number
  moved: string[]
  failures: { slug: string; from: string; error: string }[]
  lanesRemoved: string[]
}

/** `.upgrade-backup-2026-08-12T00-45-00` next to the lanes. */
function backupDirName(nowMs: number): string {
  return `.upgrade-backup-${new Date(nowMs).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
}

function backupLanes(root: string, dir: string): number {
  let copied = 0
  for (const status of TASK_STATUSES) {
    const lane = legacyLaneDir(root, status)
    if (!existsSync(lane)) continue
    let files: string[]
    try {
      files = readdirSync(lane).filter(f => f.endsWith('.md'))
    } catch {
      continue
    }
    if (files.length === 0) continue
    mkdirSync(join(dir, status), { recursive: true })
    for (const file of files) {
      cpSync(join(lane, file), join(dir, status, file))
      copied++
    }
  }
  return copied
}

/**
 * Move one lane card into `cards/`, pinning the lane it came from as `status:`.
 * Write-then-unlink: if the unlink fails we are left with a harmless duplicate
 * (the canonical card shadows the legacy one) that the next run cleans up.
 * Returns an error string, or null on success.
 */
function migrateCard(root: string, card: LegacyCard): string | null {
  const dest = cardPath(root, card.slug)
  if (existsSync(dest)) return 'a canonical card with this id already exists'
  let raw: string
  try {
    raw = readFileSync(card.abs, 'utf8')
  } catch (err) {
    return `unreadable: ${(err as Error).message}`
  }
  const { meta, body, raw: blocks } = parseFrontmatter(raw)
  try {
    // The DIRECTORY wins over any stale `status:` key already in the file: it
    // is where the board actually had this card.
    writeFileSync(dest, serializeCard({ ...meta, status: card.status }, body, blocks), 'utf8')
  } catch (err) {
    return `write failed: ${(err as Error).message}`
  }
  try {
    unlinkSync(card.abs)
  } catch {
    /* duplicate left behind; canonical wins, next run tidies it */
  }
  const when = new Date(card.mtime)
  try {
    utimesSync(dest, when, when)
  } catch {
    /* mtime is a sort hint */
  }
  return null
}

/** Drop lane directories that are now empty. Anything left behind is kept. */
function pruneEmptyLanes(root: string): string[] {
  const removed: string[] = []
  for (const status of TASK_STATUSES) {
    const lane = legacyLaneDir(root, status)
    if (!existsSync(lane)) continue
    try {
      if (readdirSync(lane).length > 0) continue
      rmdirSync(lane)
      removed.push(status)
    } catch {
      /* not empty, or not ours to remove */
    }
  }
  return removed
}

/** Immediate subdirectories of `parent` that actually hold a board. */
export function findProjectBoards(parent: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return []
  }
  return entries
    .map(name => join(parent, name))
    .filter(root => {
      try {
        return existsSync(boardRoot(root))
      } catch {
        return false
      }
    })
    .sort()
}

/** Run the sweep. Idempotent: on an already-migrated board it does nothing. */
export function upgradeProjectBoard(root: string, opts: UpgradeOptions = {}): UpgradeReport {
  const { dryRun = false, backup = true, nowMs = Date.now() } = opts
  const board = boardRoot(root)
  const report: UpgradeReport = {
    board,
    noBoard: !existsSync(board),
    legacy: [],
    collisions: [],
    backedUp: 0,
    moved: [],
    failures: [],
    lanesRemoved: [],
  }
  if (report.noBoard) return report

  report.collisions = listLegacyCollisions(root)
  report.legacy = listLegacyCards(root)

  if (!dryRun && report.legacy.length > 0) {
    if (backup) {
      report.backupDir = join(board, backupDirName(nowMs))
      report.backedUp = backupLanes(root, report.backupDir)
    }
    mkdirSync(cardsDir(root), { recursive: true })
    for (const card of report.legacy) {
      const error = migrateCard(root, card)
      if (error) report.failures.push({ slug: card.slug, from: card.status, error })
      else report.moved.push(card.slug)
    }
    report.lanesRemoved = pruneEmptyLanes(root)
  }

  return report
}
