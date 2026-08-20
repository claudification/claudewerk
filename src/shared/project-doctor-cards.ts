/**
 * Card-level checks: can this file be read, and does its frontmatter say what
 * the board will act on?
 *
 * The one that matters most is `status`. `toProjectTask` falls back to `inbox`
 * for a missing OR unrecognised value, so a typo'd lane does not fail loudly --
 * the card just quietly appears in a lane nobody put it in. That silent
 * coercion is exactly the class of thing a doctor exists to surface.
 *
 * That check no longer lives here. `status`, `title` and every other KNOWN key
 * are declared once in `card-schema.ts` and validated by
 * `project-doctor-schema.ts`, so the doctor and the store cannot disagree about
 * what a card may carry. What is left in this file is the handful of questions
 * about the FILE rather than about a key: can it be read, does it have a
 * frontmatter block at all, is there a body.
 *
 * This runs on the write hook too (project-card-hook.ts), so a mistyped key
 * reaches the agent while it still has the context to fix it -- which is the
 * whole point of a registry that ships inside the bundle.
 */

import { parseCardFrontmatter } from './card-frontmatter'
import { checkCardSchema } from './project-doctor-schema'
import type { DoctorFinding } from './project-doctor-types'

export interface CardSource {
  id: string
  /** File contents, or null when the file could not be read. */
  content: string | null
  /** Lane directory it was found in, for a card still living in a legacy lane. */
  laneStatus?: string
}

export function checkCard(card: CardSource): DoctorFinding[] {
  if (card.content === null) {
    return [
      {
        check: 'card-unreadable',
        severity: 'error',
        subject: card.id,
        problem: 'the card file could not be read',
        remedy: 'check permissions, or delete the card if it is a leftover',
      },
    ]
  }

  const { meta, body } = parseCardFrontmatter(card.content)
  const findings = checkCardSchema({ id: card.id, meta, laneStatus: card.laneStatus })

  if (!card.content.startsWith('---')) {
    findings.push({
      check: 'card-no-frontmatter',
      severity: 'warning',
      subject: card.id,
      problem: 'no frontmatter block -- title, lane, priority and tags are all defaulted',
      remedy: 'add a `---` frontmatter block with at least `title:` and `status:`',
    })
  }
  if (body.trim() === '') {
    findings.push({
      check: 'card-empty-body',
      severity: 'info',
      subject: card.id,
      problem: 'the card has no body -- nothing but frontmatter',
      remedy: 'write what the card is for, or delete it',
    })
  }
  return findings
}
