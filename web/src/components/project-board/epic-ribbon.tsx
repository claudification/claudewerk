/**
 * The whole epic roster, in one 30px strip above the columns.
 *
 * This is what the EPICS view cost seven screens to say. Click a chip to filter
 * the board to that epic; click it again to clear. Childless epics collapse
 * into a single trailing chip rather than each taking a slot, because an epic
 * with nothing in it is a fact about the board, not seven of them.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import { cn, haptic } from '@/lib/utils'
import { EpicMarkBadge } from './epic-mark-badge'

function RibbonChip({
  rollup,
  selected,
  onSelect,
}: {
  rollup: EpicRollup
  selected: boolean
  onSelect: (epicId: string) => void
}) {
  const title = rollup.card?.title ?? rollup.epicId
  return (
    <button
      type="button"
      title={`${title} -- ${rollup.done}/${rollup.total} done`}
      style={epicColorVars(epicHue(rollup.epicId, rollup.card?.color))}
      onClick={() => {
        haptic('tap')
        onSelect(rollup.epicId)
      }}
      className={cn(
        'flex items-center gap-2 px-2.5 py-1.5 min-w-0 shrink-0 border-r border-border/50 transition-colors',
        selected ? 'bg-[color:var(--epic-tint)] shadow-[inset_0_-2px_0_var(--epic-solid)]' : 'hover:bg-muted/40',
      )}
    >
      <EpicMarkBadge epicId={rollup.epicId} variant={selected ? 'solid' : 'quiet'} />
      <span className="font-mono text-read text-foreground truncate max-w-[11rem]">{title}</span>
      <span className="font-mono text-meta tabular-nums text-muted-foreground/80">
        {rollup.done}/{rollup.total}
      </span>
    </button>
  )
}

export function EpicRibbon({
  rollups,
  selected,
  looseCount,
  onSelect,
}: {
  rollups: EpicRollup[]
  /** The epic the board is filtered to, or null for the whole board. */
  selected: string | null
  /** Live unparented cards -- the trailing chip, and never styled as a warning. */
  looseCount: number
  onSelect: (epicId: string | null) => void
}) {
  const withWork = rollups.filter(r => r.children.length > 0)
  const emptyCount = rollups.length - withWork.length
  if (rollups.length === 0) return null

  return (
    <div className="flex items-stretch overflow-x-auto scrollbar-none border-b border-border shrink-0">
      {withWork.map(rollup => (
        <RibbonChip
          key={rollup.epicId}
          rollup={rollup}
          selected={selected === rollup.epicId}
          onSelect={id => onSelect(selected === id ? null : id)}
        />
      ))}

      {emptyCount > 0 && (
        <span
          className="flex items-center px-2.5 py-1.5 shrink-0 border-r border-border/50 font-mono text-meta text-muted-foreground/60"
          title="Tagged `epic`, nothing points at them yet"
        >
          {emptyCount} empty
        </span>
      )}

      {looseCount > 0 && (
        <span className="flex items-center gap-2 ml-auto px-2.5 py-1.5 shrink-0 border-l border-border/50">
          <span aria-hidden className="text-meta text-muted-foreground/55">
            ●
          </span>
          <span className="font-mono text-read text-muted-foreground/85">no epic</span>
          <span className="font-mono text-meta tabular-nums text-muted-foreground/80">{looseCount}</span>
        </span>
      )}
    </div>
  )
}
