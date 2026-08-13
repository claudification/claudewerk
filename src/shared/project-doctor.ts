/**
 * PROJECT DOCTOR -- read the whole board, report everything wrong with it, and
 * say what to do about each one.
 *
 * READ ONLY, ALWAYS. The doctor never writes, moves or deletes anything: the
 * board is the user's data and a health check that "helpfully" repairs things
 * is how you lose a card you were about to look at. Every finding names its
 * remedy instead, and the remedies are existing commands (`board:upgrade`
 * rebuilds the views farm and drains legacy lanes) or a one-line hand edit.
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
import { parseFrontmatter } from './frontmatter'
import { checkCard } from './project-doctor-cards'
import { checkEpics, type EpicCardView } from './project-doctor-epics'
import { checkLayout } from './project-doctor-layout'
import { checkLinks } from './project-doctor-links'
import { type DoctorFinding, type DoctorReport, sortFindings } from './project-doctor-types'
import { listLegacyCards } from './project-legacy'
import { boardRoot } from './project-paths'
import { listProjectManifest, locateCard } from './project-store'
import type { TaskStatus } from './task-statuses'

interface LoadedCard {
  id: string
  status: TaskStatus
  /** Raw file contents -- null when the file could not be read. */
  raw: string | null
  /** Set only for a card still living in a legacy lane directory. */
  laneStatus?: string
}

function readRaw(root: string, id: string): string | null {
  const found = locateCard(root, id)
  if (!found) return null
  try {
    return readFileSync(found.abs, 'utf8')
  } catch {
    return null
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
    raw: readRaw(root, entry.slug),
    laneStatus: legacyIds.has(entry.slug) ? entry.status : undefined,
  }))
}

function cardFindings(card: LoadedCard, existingIds: ReadonlySet<string>): DoctorFinding[] {
  const findings = checkCard({ id: card.id, content: card.raw, laneStatus: card.laneStatus })
  if (card.raw === null) return findings
  const { meta, body } = parseFrontmatter(card.raw)
  const refs = Array.isArray(meta.refs) ? meta.refs.map(String) : []
  return [...findings, ...checkLinks({ id: card.id, body, refs }, existingIds)]
}

/** Project the loaded cards down to what the epic checks need. Unreadable cards
 *  are dropped -- `card-unreadable` already reports those, and guessing at their
 *  linkage would stack a second finding on the same root cause. */
function epicViews(cards: LoadedCard[]): EpicCardView[] {
  const out: EpicCardView[] = []
  for (const card of cards) {
    if (card.raw === null) continue
    const { meta } = parseFrontmatter(card.raw)
    out.push({
      id: card.id,
      status: card.status,
      tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
      epic: meta.epic ? String(meta.epic) : undefined,
      dependsOn: Array.isArray(meta.depends_on) ? meta.depends_on.map(String) : [],
    })
  }
  return out
}

export function runProjectDoctor(root: string): DoctorReport {
  const board = boardRoot(root)
  if (!existsSync(board)) return { board, noBoard: true, cards: 0, findings: [] }

  const legacy = listLegacyCards(root)
  const cards = loadCards(root, new Set(legacy.map(c => c.slug)))
  const existingIds = new Set(cards.map(c => c.id))

  const findings: DoctorFinding[] = []
  for (const card of cards) findings.push(...cardFindings(card, existingIds))
  findings.push(...checkEpics(epicViews(cards)))
  findings.push(...checkLayout(root, legacy.length))

  return { board, noBoard: false, cards: cards.length, findings: sortFindings(findings) }
}
