/**
 * PROJECT DOCTOR -- read the whole board, report everything wrong with it, and
 * say what to do about each one.
 *
 * READ ONLY BY DEFAULT. The doctor does not move or delete anything, ever: the
 * board is the user's data and a health check that "helpfully" reorganises
 * things is how you lose a card you were about to look at. Every finding names
 * its remedy instead, and the remedies are existing commands (`board:upgrade`
 * drains legacy lanes) or a one-line hand edit.
 *
 * The ONE exception is `opts.repair`, which is `off` unless a caller asks --
 * so this function keeps its read-only contract for every library caller, and
 * only the CLI opts in. It gates a single auto-repair (stamping an absent
 * `created:` from the filesystem, see project-doctor-created.ts) chosen because
 * it can only ADD a key that was not saying anything. The general rule: if the
 * fix is unambiguous and the data is already on disk, REPAIRING beats
 * REPORTING -- a doctor that nags about what it could have fixed itself trains
 * people to ignore the doctor. Anything requiring a judgement stays a finding.
 *
 * The checks read the RAW card file, not a projected `ProjectTask` -- projection
 * has already applied the defaults (missing lane -> `inbox`, missing title ->
 * the id) that are the very things being checked.
 *
 * Pure filesystem + string work, same as project-store, so it runs wherever the
 * project's files live -- the CLI today, a sentinel RPC or MCP tool later
 * without moving a line of it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { readLinkage, readOne } from './card-linkage-read'
import { parseFrontmatter } from './frontmatter'
import { checkCard } from './project-doctor-cards'
import { fsStampDeps, type RepairMode, stampMissingCreated } from './project-doctor-created'
import { checkEpics, type EpicCardView } from './project-doctor-epics'
import { checkLayout } from './project-doctor-layout'
import { checkLinkageKeys } from './project-doctor-linkage'
import { checkLinks } from './project-doctor-links'
import { type DoctorFinding, type DoctorReport, sortFindings } from './project-doctor-types'
import { listLegacyCards } from './project-legacy'
import { boardRoot } from './project-paths'
import { listProjectManifest, locateCard } from './project-store'
import type { TaskStatus } from './task-statuses'

interface LoadedCard {
  id: string
  status: TaskStatus
  /** Where the file actually lies -- the repair pass writes back to it. Null
   *  when the board lists a card that is no longer on disk. */
  abs: string | null
  /** Raw file contents -- null when the file could not be read. */
  raw: string | null
  /** Set only for a card still living in a legacy lane directory. */
  laneStatus?: string
}

function readRaw(root: string, id: string): { abs: string | null; raw: string | null } {
  const found = locateCard(root, id)
  if (!found) return { abs: null, raw: null }
  try {
    return { abs: found.abs, raw: readFileSync(found.abs, 'utf8') }
  } catch {
    return { abs: found.abs, raw: null }
  }
}

/**
 * Every card the BOARD can see -- canonical plus any still in legacy lanes.
 * Enumerating through `listProjectManifest` is deliberate: the doctor must see
 * exactly what the board sees, and a second discovery path would drift.
 */
function loadCards(root: string, legacyIds: Set<string>): LoadedCard[] {
  return listProjectManifest(root).map(entry => ({
    id: entry.slug,
    status: entry.status,
    ...readRaw(root, entry.slug),
    laneStatus: legacyIds.has(entry.slug) ? entry.status : undefined,
  }))
}

function cardFindings(card: LoadedCard, existingIds: ReadonlySet<string>): DoctorFinding[] {
  const findings = checkCard({ id: card.id, content: card.raw, laneStatus: card.laneStatus })
  if (card.raw === null) return findings
  const { meta, body } = parseFrontmatter(card.raw)
  const refs = Array.isArray(meta.refs) ? meta.refs.map(String) : []
  return [
    ...findings,
    ...checkLinkageKeys({ id: card.id, meta }),
    ...checkLinks({ id: card.id, body, refs }, existingIds),
  ]
}

/**
 * Project the loaded cards down to what the linkage pass needs. The FULL
 * linkage bag rides along (aliases already folded by `readLinkage`), so every
 * verb in the registry gets resolved -- not only the two epics happen to use.
 *
 * Unreadable cards are dropped: `card-unreadable` already reports those, and
 * guessing at their linkage would stack a second finding on one root cause.
 */
function epicViews(cards: LoadedCard[]): EpicCardView[] {
  const out: EpicCardView[] = []
  for (const card of cards) {
    if (card.raw === null) continue
    const { meta } = parseFrontmatter(card.raw)
    const linkage = readLinkage(meta)
    out.push({
      id: card.id,
      status: card.status,
      tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
      epic: readOne(linkage, 'epic'),
      dependsOn: linkage.depends_on ?? [],
      linkage,
    })
  }
  return out
}

/**
 * The one pass that WRITES, kept in its own function so the boundary is visible
 * at a glance: every check above this line only reads. `off` short-circuits
 * before the deps are even built, so the default path touches nothing.
 */
function repairPass(cards: LoadedCard[], mode: RepairMode): DoctorFinding[] {
  if (mode === 'off') return []
  const deps = fsStampDeps(Date.now())
  return cards.flatMap(card =>
    card.abs === null ? [] : stampMissingCreated({ id: card.id, abs: card.abs, content: card.raw }, mode, deps),
  )
}

export interface DoctorOptions {
  /**
   * Auto-repair mode. `off` (the default) keeps this function strictly
   * read-only, which is what any library caller -- a sentinel RPC, an MCP tool
   * -- should get without having to know it asked for anything. `write` stamps,
   * `preview` reports what `write` would have done.
   */
  repair?: RepairMode
}

export function runProjectDoctor(root: string, opts: DoctorOptions = {}): DoctorReport {
  const board = boardRoot(root)
  if (!existsSync(board)) return { board, noBoard: true, cards: 0, findings: [] }

  const legacy = listLegacyCards(root)
  const cards = loadCards(root, new Set(legacy.map(c => c.slug)))
  const existingIds = new Set(cards.map(c => c.id))

  const findings: DoctorFinding[] = []
  for (const card of cards) findings.push(...cardFindings(card, existingIds))
  findings.push(...checkEpics(epicViews(cards)))
  findings.push(...checkLayout(root, legacy.length))
  findings.push(...repairPass(cards, opts.repair ?? 'off'))

  return { board, noBoard: false, cards: cards.length, findings: sortFindings(findings) }
}
