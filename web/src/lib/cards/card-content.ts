/**
 * A card as it appears in a FILE, parsed -- the input side of the card preview.
 *
 * Pure and separate from the component on purpose: whether some bytes are a
 * renderable card is a decision the caller has to make BEFORE it renders (it
 * has a source-dump fallback to fall back to), and a component that returns
 * null cannot be asked that question.
 *
 * Deliberately forgiving. A card whose frontmatter carries neither a title nor
 * a known status is not a card -- everything else (a lane we do not know, no
 * tags, an empty body) still renders.
 */

import { parseFrontmatter } from '@shared/frontmatter'
import { TASK_STATUSES, type TaskStatus } from '@shared/task-statuses'
import { BOARD_LANE_STATE } from './board-lanes'
import type { CardState } from './types'

export interface ParsedCard {
  /** The lane word verbatim, or null when the file does not name a known one. */
  status: TaskStatus | null
  /** Canonical state for colour. `unknown` when there is no usable status. */
  state: CardState
  title: string
  priority: string
  epic: string
  tags: string[]
  body: string
}

function asStatus(v: unknown): TaskStatus | null {
  return (TASK_STATUSES as readonly string[]).includes(String(v)) ? (String(v) as TaskStatus) : null
}

export function parseCardContent(content: string): ParsedCard | null {
  const { meta, body } = parseFrontmatter(content)
  const status = asStatus(meta.status)
  const title = meta.title ? String(meta.title) : ''
  if (!status && !title) return null
  return {
    status,
    state: status ? BOARD_LANE_STATE[status] : 'unknown',
    title,
    priority: meta.priority ? String(meta.priority) : '',
    epic: meta.epic ? String(meta.epic) : '',
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    body,
  }
}
