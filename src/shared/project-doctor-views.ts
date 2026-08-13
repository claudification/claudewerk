/**
 * The `views/` symlink farm, audited.
 *
 * Nothing in the codebase READS this farm -- it exists so `ls`, Finder and a
 * file tree can show you lanes. That is precisely why it rots unnoticed: a card
 * hand-written straight into `cards/` never gets a link, a card whose lane was
 * changed by something that did not call `relinkCard` keeps its old one, and a
 * DUPLICATE (the same id linked from two lanes at once) makes the board look
 * like it holds two cards when it holds one.
 *
 * All of it is cosmetic and all of it is rebuildable, so every remedy here is
 * the same one command. The point is telling you the farm has drifted, because
 * a stale lane view is read by humans as the truth.
 */

import { lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CARDS_DIR } from './card-path'
import type { DoctorFinding } from './project-doctor-types'
import { viewsDir } from './project-paths'
import { TASK_STATUSES, type TaskStatus } from './task-statuses'

const REBUILD = 'run `bun run board:upgrade --root <project>` -- it rebuilds the farm from the cards'

interface ViewLink {
  id: string
  lane: TaskStatus
  abs: string
}

function laneLinks(root: string, lane: TaskStatus): ViewLink[] {
  let entries: string[]
  try {
    entries = readdirSync(viewsDir(root, lane))
  } catch {
    return [] // lane view dir absent -- normal
  }
  return entries
    .filter(f => f.endsWith('.md'))
    .map(f => ({ id: f.slice(0, -3), lane, abs: join(viewsDir(root, lane), f) }))
}

/** One link: a symlink, aimed at this id's card, whose target actually exists. */
function checkLink(link: ViewLink, cardLane: TaskStatus | undefined): DoctorFinding[] {
  const subject = `views/${link.lane}/${link.id}.md`
  let isLink = false
  try {
    isLink = lstatSync(link.abs).isSymbolicLink()
  } catch {
    return []
  }
  if (!isLink) {
    return [
      {
        check: 'view-not-a-symlink',
        severity: 'warning',
        subject,
        problem: 'a REAL FILE in the generated views tree -- edits to it are invisible to the board',
        remedy: `move its content into ${CARDS_DIR}/${link.id}.md if it matters, then delete this file`,
      },
    ]
  }

  const findings: DoctorFinding[] = []
  const target = readTarget(link.abs)
  const wanted = join('..', '..', CARDS_DIR, `${link.id}.md`)
  if (target !== wanted) {
    findings.push({
      check: 'view-wrong-target',
      severity: 'warning',
      subject,
      problem: `points at "${target ?? '(unreadable)'}" instead of "${wanted}"`,
      remedy: REBUILD,
    })
  }
  if (!exists(link.abs)) {
    findings.push({
      check: 'view-dangling',
      severity: 'warning',
      subject,
      problem: 'the card it points at is gone',
      remedy: REBUILD,
    })
  } else if (cardLane && cardLane !== link.lane) {
    findings.push({
      check: 'view-wrong-lane',
      severity: 'warning',
      subject,
      problem: `card "${link.id}" is in \`${cardLane}\`, so this lane view is stale`,
      remedy: REBUILD,
    })
  }
  return findings
}

function readTarget(abs: string): string | null {
  try {
    return readlinkSync(abs)
  } catch {
    return null
  }
}

/** statSync follows the link, so this is "the TARGET exists", which is the question. */
function exists(abs: string): boolean {
  try {
    statSync(abs)
    return true
  } catch {
    return false
  }
}

/**
 * Audit the whole farm against the card set. `cardLanes` maps id -> its real
 * lane; an id missing from it is a link to a card that does not exist.
 */
export function checkViews(root: string, cardLanes: Map<string, TaskStatus>): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  const lanesSeenPerId = new Map<string, TaskStatus[]>()

  for (const lane of TASK_STATUSES) {
    for (const link of laneLinks(root, lane)) {
      lanesSeenPerId.set(link.id, [...(lanesSeenPerId.get(link.id) ?? []), lane])
      findings.push(...checkLink(link, cardLanes.get(link.id)))
    }
  }

  for (const [id, lanes] of lanesSeenPerId) {
    if (lanes.length < 2) continue
    findings.push({
      check: 'view-duplicate',
      severity: 'warning',
      subject: id,
      problem: `linked from ${lanes.length} lanes at once (${lanes.join(', ')}) -- one card looks like ${lanes.length}`,
      remedy: REBUILD,
    })
  }

  for (const [id, lane] of cardLanes) {
    if (lanesSeenPerId.has(id)) continue
    findings.push({
      check: 'view-missing',
      severity: 'info',
      subject: id,
      problem: `no view link, so the card is invisible under views/${lane}/`,
      remedy: REBUILD,
    })
  }

  return findings
}
