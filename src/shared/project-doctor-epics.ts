/**
 * EPIC INTEGRITY -- parenthood that does not hold up.
 *
 * `epic:` is a plain string pointing at another card's id, so it can point at
 * nothing, at an ordinary card, or (once someone edits two cards) in a circle.
 * None of those show up in the UI as anything but a slightly odd-looking board.
 *
 * SEVERITY RULE, and it is the important one: pointing at a card that does not
 * exist YET is a WARNING, never an error. Cards get written out of order all the
 * time -- you sketch the children while the epic is still in your head, or name
 * a sibling you are about to write. A gate that treats a forward reference as a
 * failure teaches people to stop writing links, which costs far more than the
 * dangling reference ever did. Only a contradiction the board cannot resolve --
 * a cycle -- is an error.
 */

import { EPIC_TAG } from './epic-cards'
import type { DoctorFinding } from './project-doctor-types'
import type { TaskStatus } from './task-statuses'

export interface EpicCardView {
  id: string
  tags: string[]
  status: TaskStatus
  /** `epic:` frontmatter -- the parent this card claims. */
  epic?: string
  /** `depends_on:` frontmatter -- siblings this card waits on. */
  dependsOn: string[]
}

const TERMINAL: TaskStatus[] = ['done', 'archived']

function childrenOf(cards: readonly EpicCardView[], epicId: string): EpicCardView[] {
  return cards.filter(c => c.epic === epicId)
}

/** A -> B -> A, or a card naming itself. Longer rings are impossible: a card
 *  has exactly one `epic:`, so any cycle in a functional graph is reachable by
 *  walking forward from the node until an id repeats. */
function findCycle(card: EpicCardView, byId: ReadonlyMap<string, EpicCardView>): string[] | null {
  const seen: string[] = [card.id]
  let cursor = card.epic
  while (cursor) {
    if (seen.includes(cursor)) return [...seen, cursor]
    seen.push(cursor)
    if (seen.length > 64) return null // pathological board; do not hang
    cursor = byId.get(cursor)?.epic
  }
  return null
}

function orphanFinding(card: EpicCardView, epicId: string): DoctorFinding {
  return {
    check: 'epic-orphan',
    severity: 'warning',
    subject: card.id,
    problem: `claims epic "${epicId}", which this board does not have (yet)`,
    remedy: `fine if that card is still to be written -- otherwise fix the id or drop the key`,
  }
}

function notAnEpicFinding(card: EpicCardView, epicId: string): DoctorFinding {
  return {
    check: 'epic-not-an-epic',
    severity: 'warning',
    subject: card.id,
    problem: `claims epic "${epicId}", a card with no \`${EPIC_TAG}\` tag`,
    remedy: `add \`${EPIC_TAG}\` to that card's tags, or point this at the real epic`,
  }
}

function cycleFinding(card: EpicCardView, ring: string[]): DoctorFinding {
  return {
    check: 'epic-cycle',
    severity: 'error',
    subject: card.id,
    problem: `epic parenthood loops: ${ring.join(' -> ')}`,
    remedy: `remove the \`epic:\` key from one card in the ring -- an epic cannot descend from itself`,
  }
}

function staleFinding(card: EpicCardView, total: number): DoctorFinding {
  return {
    check: 'epic-stale',
    severity: 'info',
    subject: card.id,
    problem: `all ${total} children are done or archived, but the epic is still \`${card.status}\``,
    remedy: `move it to done, or say in the body what is still outstanding`,
  }
}

function dependsFindings(card: EpicCardView, byId: ReadonlyMap<string, EpicCardView>): DoctorFinding[] {
  const out: DoctorFinding[] = []
  for (const dep of card.dependsOn) {
    if (dep === card.id) {
      out.push({
        check: 'epic-depends-self',
        severity: 'error',
        subject: card.id,
        problem: `depends_on lists itself, so it can never become ready`,
        remedy: `remove "${dep}" from depends_on`,
      })
      continue
    }
    const target = byId.get(dep)
    if (!target) {
      out.push({
        check: 'epic-depends-missing',
        severity: 'warning',
        subject: card.id,
        problem: `depends_on "${dep}", which this board does not have (yet)`,
        remedy: `fine if that card is still to be written -- otherwise fix the id or drop it`,
      })
      continue
    }
    if (card.epic && target.epic && target.epic !== card.epic) {
      out.push({
        check: 'epic-depends-outside',
        severity: 'info',
        subject: card.id,
        problem: `waits on "${dep}", which belongs to a different epic ("${target.epic}")`,
        remedy: `expected for a genuine cross-epic dependency -- otherwise one of the two epic: keys is wrong`,
      })
    }
  }
  return out
}

/** Every epic-linkage problem on the board, in one pass. */
export function checkEpics(cards: readonly EpicCardView[]): DoctorFinding[] {
  const byId = new Map(cards.map(c => [c.id, c]))
  const findings: DoctorFinding[] = []

  for (const card of cards) {
    if (card.epic) {
      const ring = findCycle(card, byId)
      const parent = byId.get(card.epic)
      if (ring) findings.push(cycleFinding(card, ring))
      else if (!parent) findings.push(orphanFinding(card, card.epic))
      else if (!parent.tags.includes(EPIC_TAG)) findings.push(notAnEpicFinding(card, card.epic))
    }
    findings.push(...dependsFindings(card, byId))

    if (!card.tags.includes(EPIC_TAG) || TERMINAL.includes(card.status)) continue
    const kids = childrenOf(cards, card.id)
    if (kids.length > 0 && kids.every(k => TERMINAL.includes(k.status))) {
      findings.push(staleFinding(card, kids.length))
    }
  }
  return findings
}
