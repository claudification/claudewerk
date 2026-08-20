/**
 * What a wall row says when you rest on it.
 *
 * A pane column is ~407px and every row on the wall has already thrown away
 * most of what it knows to fit: the pulse row drops model, host, cost and
 * context pressure and truncates its action line; the river row truncates the
 * commit subject and shows two numbers of a diffstat. The hover is where that
 * comes back -- so the preview is not a repeat of the row with bigger type, it
 * is the fields the row could not afford.
 *
 * ONE POPOVER SYSTEM. These are thin wrappers over `card-hover-bus`, the layer
 * the transcript's card links already use. Ledger rows go through the CARD
 * content, so a card preview on the wall and one in a transcript are the same
 * panel with the same lookup; commits go through the COMMIT content, which
 * `wall-commit-detail-in-wall` reuses; a pulse row has no provider behind it and
 * hands over finished facts.
 *
 * TOUCH NEVER OPENS ONE. `canHover()` is checked against the ANCHOR's window,
 * which is the popup when the wall is detached -- and only the pointer paths go
 * through it, so a keyboard user still reaches the card panel by focus.
 */

import {
  canHover,
  closeCardHover,
  openCardHover,
  openCommitHover,
  openFactsHover,
} from '@/components/card-hover/card-hover-bus'
import type { HoverFacts } from '@/components/card-hover/hover-facts'
import type { PulseRow } from '@/components/pulse/use-pulse-fleet'
import { projectBoardCardRef } from '@/lib/cards'
import { pulseAge } from '@/lib/pulse/action-text'
import { formatUsd } from '@/lib/wall/burn-splits'
import type { RiverRow } from '@/lib/wall/commit-river'

/** True when a pointer over `anchor` is a real hovering pointer, not a tap. */
function hoverable(anchor: HTMLElement): boolean {
  return canHover(anchor.ownerDocument.defaultView ?? window)
}

/**
 * A pulse row's preview. Pure, so the payload is testable without a DOM -- the
 * bug this shape prevents is a preview that silently says `undefined` for a
 * conversation with no cost recorded yet.
 */
export function pulseHoverFacts(row: PulseRow): HoverFacts {
  return {
    kicker: row.band,
    title: row.title,
    facts: [
      ['last', pulseAge(row.ageMs)],
      ['model', row.model ?? ''],
      ['host', row.host ?? ''],
      ['cost', row.costUsd === undefined ? '' : formatUsd(row.costUsd)],
      ['context', row.contextPct === undefined ? '' : `${Math.round(row.contextPct)}%`],
      ['blocked by', row.blockedBy ?? ''],
      ['dispatched', row.managedBy?.label ?? ''],
    ],
    // The row truncates this to one column; the whole point is to read it whole.
    body: row.action,
    footer: row.tag ? `${row.project} · ${row.tag}` : row.project,
  }
}

/** Rest on a pulse row: everything the band line could not fit. */
export function hoverPulseRow(row: PulseRow, anchor: HTMLElement): void {
  if (!hoverable(anchor)) return
  openFactsHover(pulseHoverFacts(row), anchor)
}

/** Rest on a river row: the full message body and the file stat summary. */
export function hoverCommitRow(row: RiverRow, anchor: HTMLElement): void {
  if (!hoverable(anchor)) return
  openCommitHover(row.hash, anchor)
}

/** Rest on a ledger row: the card's own opening lines, same panel as a link. */
export function hoverCardRow(id: string, project: string, anchor: HTMLElement): void {
  if (!hoverable(anchor)) return
  openCardHover(projectBoardCardRef(id, project), anchor)
}

/** Leaving any wall row. One verb so no pane invents its own close rule. */
export function leaveWallRow(): void {
  closeCardHover()
}
