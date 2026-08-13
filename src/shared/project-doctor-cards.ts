/**
 * Card-level checks: can this file be read, and does its frontmatter say what
 * the board will act on?
 *
 * The one that matters most is `status`. `toProjectTask` falls back to `inbox`
 * for a missing OR unrecognised value, so a typo'd lane does not fail loudly --
 * the card just quietly appears in a lane nobody put it in. That silent
 * coercion is exactly the class of thing a doctor exists to surface.
 */

import { parseFrontmatter } from './frontmatter'
import { asStatus } from './project-card-file'
import type { DoctorFinding } from './project-doctor-types'
import { TASK_STATUSES } from './task-statuses'

export interface CardSource {
  id: string
  /** File contents, or null when the file could not be read. */
  content: string | null
  /** Lane directory it was found in, for a card still living in a legacy lane. */
  laneStatus?: string
}

const LANES = TASK_STATUSES.join(' | ')

function statusFindings(card: CardSource, meta: Record<string, unknown>): DoctorFinding[] {
  const raw = meta.status
  if (raw === undefined || raw === null || raw === '') {
    // A legacy-lane card gets its status from the directory, so it is not broken
    // -- it just has not been drained yet, which the layout check reports.
    if (card.laneStatus) return []
    return [
      {
        check: 'card-status-missing',
        severity: 'warning',
        subject: card.id,
        problem: 'no `status:` key -- the board silently renders it as `inbox`',
        remedy: `add \`status:\` (${LANES}) to the frontmatter, or move it once with project_set_status`,
      },
    ]
  }
  if (asStatus(raw)) return []
  return [
    {
      check: 'card-status-invalid',
      severity: 'error',
      subject: card.id,
      problem: `status: "${String(raw)}" is not a lane -- the board silently renders it as \`inbox\``,
      remedy: `set \`status:\` to one of ${LANES}`,
    },
  ]
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

  const { meta, body } = parseFrontmatter(card.content)
  const findings = statusFindings(card, meta)

  if (!card.content.startsWith('---')) {
    findings.push({
      check: 'card-no-frontmatter',
      severity: 'warning',
      subject: card.id,
      problem: 'no frontmatter block -- title, lane, priority and tags are all defaulted',
      remedy: 'add a `---` frontmatter block with at least `title:` and `status:`',
    })
  }
  if (!meta.title) {
    findings.push({
      check: 'card-title-missing',
      severity: 'info',
      subject: card.id,
      problem: 'no `title:` -- the board falls back to showing the raw id',
      remedy: 'add a `title:` line',
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
