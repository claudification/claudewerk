/**
 * One epic in the EPICS view: a colour rail, a header, and its children as a
 * listing when expanded.
 *
 * The epic's hue is set HERE, once, as CSS custom properties on the root. Every
 * descendant reads `var(--epic-solid)` and inherits it, so a child row never has
 * to know which epic it belongs to in order to paint like it does.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import { useMemo } from 'react'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import { haptic } from '@/lib/utils'
import { EpicChildTable } from './epic-child-table'
import { EpicSwimlaneHeader } from './epic-swimlane-header'

export function EpicSwimlane({
  rollup,
  expanded,
  onToggle,
  onOpenCard,
  onWorkOnEpic,
}: {
  rollup: EpicRollup
  expanded: boolean
  onToggle: (epicId: string) => void
  onOpenCard: (slug: string) => void
  onWorkOnEpic: (epicId: string) => void
}) {
  const style = useMemo(
    () => epicColorVars(epicHue(rollup.epicId, rollup.card?.color)),
    [rollup.epicId, rollup.card?.color],
  )

  function toggle(epicId: string) {
    haptic('tap')
    onToggle(epicId)
  }

  return (
    <div style={style} className="border-b border-border/50 border-l-2 border-l-[color:var(--epic-solid)]">
      <EpicSwimlaneHeader rollup={rollup} expanded={expanded} onToggle={toggle} onWorkOnEpic={onWorkOnEpic} />

      {!expanded && rollup.children.length === 0 && (
        <div className="px-3 pb-2 pl-10 text-[10px] font-mono text-muted-foreground/40">
          no children yet -- tagged `epic`, nothing points at it
        </div>
      )}

      {expanded && (
        <div className="px-3 pb-3 pl-10 space-y-2">
          <EpicChildTable rows={rollup.children} onOpenCard={onOpenCard} />
          {rollup.children.length === 0 && (
            <div className="text-[10px] font-mono text-muted-foreground/40">
              no children yet -- put `epic: {rollup.epicId}` on a card to adopt it
            </div>
          )}
          {rollup.dropped > 0 && (
            <div className="text-[10px] font-mono text-muted-foreground/40">
              ⊘ {rollup.dropped} dropped -- excluded from the percentage
            </div>
          )}
        </div>
      )}
    </div>
  )
}
