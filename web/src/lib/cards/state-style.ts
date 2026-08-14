/**
 * How a canonical `CardState` looks. One table, used by the inline glyph, the
 * hover header and the epic progress bar, so a lane can never be blue in one
 * place and green in another.
 *
 * Colours are the board's existing semantic tokens -- no new palette:
 *   triage magenta - todo blue - active amber - review cyan - done green.
 */

import type { CardState } from './types'

interface StateStyle {
  /** Text colour class for the glyph, the dot and the lane word. */
  text: string
  /** Background class for a filled progress segment. */
  fill: string
}

export const CARD_STATE_STYLE: Record<CardState, StateStyle> = {
  triage: { text: 'text-event-prompt', fill: 'bg-event-prompt' },
  todo: { text: 'text-primary', fill: 'bg-primary' },
  active: { text: 'text-accent', fill: 'bg-accent' },
  review: { text: 'text-info', fill: 'bg-info' },
  done: { text: 'text-active', fill: 'bg-active' },
  dropped: { text: 'text-muted-foreground', fill: 'bg-muted-foreground' },
  unknown: { text: 'text-muted-foreground', fill: 'bg-muted-foreground' },
}

/** Progress buckets an epic rolls its children into. */
export const CARD_PROGRESS_BUCKET: Record<CardState, 'todo' | 'active' | 'done' | 'dropped'> = {
  triage: 'todo',
  todo: 'todo',
  active: 'active',
  review: 'active',
  done: 'done',
  dropped: 'dropped',
  unknown: 'todo',
}
