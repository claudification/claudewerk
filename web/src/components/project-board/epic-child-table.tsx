/**
 * An epic's children as one dense listing, not three bucket boxes.
 *
 * The bucket grid it replaces was the kanban again, nested -- which is exactly
 * what an epic is not. An epic is a list of work with an order to it, so the
 * columns that matter are the ones you scan down: which card, what it is, where
 * it stands, how urgent, and whether it can start at all.
 *
 * Long epics collapse to a head and a count. Thirteen rows is a list; forty is
 * a wall, and a wall is skipped rather than read.
 */

import type { EpicChild } from '@shared/epic-cards'
import { useState } from 'react'
import { cn, haptic } from '@/lib/utils'
import { EPIC_CHILD_GRID } from './board-constants'
import { EpicChildRow } from './epic-child-row'

const COLUMNS = ['CARD', 'TITLE', 'ST', 'PRI', 'WAITS ON']

/** How many rows show before the list folds. */
const HEAD = 8

export function EpicChildTable({ rows, onOpenCard }: { rows: EpicChild[]; onOpenCard: (slug: string) => void }) {
  const [showAll, setShowAll] = useState(false)

  if (rows.length === 0) return null

  const folded = !showAll && rows.length > HEAD
  const visible = folded ? rows.slice(0, HEAD) : rows

  return (
    <div className="border border-[color:var(--epic-edge)]">
      <div
        className={cn(
          EPIC_CHILD_GRID,
          'px-2 py-1 bg-[color:var(--epic-tint)] border-b border-[color:var(--epic-edge)]',
        )}
      >
        {COLUMNS.map(col => (
          <span key={col} className="text-chrome font-mono text-muted-foreground/60">
            {col}
          </span>
        ))}
      </div>

      <div className="divide-y divide-border/30">
        {visible.map(child => (
          <EpicChildRow key={child.card.slug} child={child} onOpen={onOpenCard} />
        ))}
      </div>

      {rows.length > HEAD && (
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            setShowAll(v => !v)
          }}
          className="w-full px-2 py-1 text-left text-meta font-mono text-muted-foreground/80 hover:text-foreground border-t border-[color:var(--epic-edge)] transition-colors"
        >
          {folded ? `… ${rows.length - HEAD} more` : 'show fewer'}
        </button>
      )}
    </div>
  )
}
