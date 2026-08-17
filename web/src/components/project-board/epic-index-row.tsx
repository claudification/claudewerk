/**
 * One epic as ONE ROW.
 *
 * The swimlane this replaces was a title, a progress bar, four bucket counts, a
 * body paragraph, a tag line and a refs line -- per epic. Seven epics filled a
 * screen with nothing but headers, and the answer to "which of these needs me"
 * required scrolling past all of them.
 *
 * A row is a name and a number. The bar's WIDTH scales with child count, so a
 * 13-child epic is physically three times a 4-child one and an epic with
 * nothing in it can never look like an epic with work in it. Everything the
 * swimlane used to shout lives in the detail pane now, for one epic at a time.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import { cn, haptic } from '@/lib/utils'
import { EpicMarkBadge } from './epic-mark-badge'

/** Widest bar, in px, for the biggest epic on the board. */
const BAR_MAX = 78
/** Narrow enough to read as "barely anything", wide enough to still be a bar. */
const BAR_MIN = 12

/**
 * Bar width in px, scaled against the biggest epic on the board.
 *
 * This is the whole reason a 13-child epic and a 1-child epic can no longer
 * look alike. Exported so the scale is pinned by a test rather than by whoever
 * last eyeballed it.
 */
export function barWidth(rollup: EpicRollup, largest: number): number {
  if (largest <= 0) return BAR_MIN
  return Math.max(BAR_MIN, Math.round((rollup.children.length / largest) * BAR_MAX))
}

/** The one line under the title: what this epic is, or what it needs. */
function subtitle(rollup: EpicRollup): React.ReactNode {
  const blocked = rollup.children.filter(c => c.waitingOn.length > 0 && c.bucket !== 'done').length
  const next = rollup.children.find(c => c.bucket === 'notStarted' && c.waitingOn.length === 0)
  return (
    <>
      {blocked > 0 && <span className="text-event-prompt">{blocked} blocked</span>}
      {blocked > 0 && next && <span className="text-muted-foreground/40"> · </span>}
      {next && (
        <>
          <span className="text-muted-foreground/60">next </span>
          <span className="text-accent">{next.card.slug}</span>
        </>
      )}
      {!blocked && !next && rollup.complete && <span className="text-active">every card finished</span>}
    </>
  )
}

export function EpicIndexRow({
  rollup,
  largest,
  selected,
  onSelect,
}: {
  rollup: EpicRollup
  /** Child count of the biggest epic, so bars share one scale. */
  largest: number
  selected: boolean
  onSelect: (epicId: string) => void
}) {
  const empty = rollup.children.length === 0
  const title = rollup.card?.title ?? rollup.epicId

  return (
    <button
      type="button"
      style={epicColorVars(epicHue(rollup.epicId, rollup.card?.color))}
      onClick={() => {
        haptic('tap')
        onSelect(rollup.epicId)
      }}
      className={cn(
        'w-full grid grid-cols-[auto_minmax(0,1fr)_78px_64px] gap-3 items-center text-left',
        'px-3 py-2 border-b border-border/40 border-l-[3px] transition-colors',
        empty ? 'border-l-muted-foreground/25' : 'border-l-[color:var(--epic-solid)]',
        selected ? 'bg-[color:var(--epic-tint)]' : 'hover:bg-muted/30',
      )}
    >
      <EpicMarkBadge epicId={rollup.epicId} variant={selected ? 'solid' : 'quiet'} />

      <span className={cn('font-mono truncate', empty ? 'text-read text-muted-foreground/90' : 'text-loud')}>
        {title}
      </span>

      {empty ? (
        <span
          aria-hidden
          style={{ width: BAR_MAX }}
          className="h-[7px] border border-dashed border-muted-foreground/30 justify-self-end"
        />
      ) : (
        <span
          style={{ width: barWidth(rollup, largest) }}
          className="flex h-[7px] bg-muted-foreground/15 justify-self-end overflow-hidden"
          role="progressbar"
          aria-valuenow={rollup.pct ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${title} progress`}
        >
          {rollup.done > 0 && <i className="bg-active" style={{ flex: rollup.done }} />}
          {rollup.inProgress > 0 && <i className="bg-accent" style={{ flex: rollup.inProgress }} />}
          {rollup.notStarted > 0 && <i className="bg-muted-foreground/35" style={{ flex: rollup.notStarted }} />}
        </span>
      )}

      <span className="font-mono text-right">
        {empty ? (
          <span className="text-read text-muted-foreground/55">--</span>
        ) : (
          <span className="text-tally tabular-nums text-foreground">
            {rollup.done}
            <span className="text-chrome font-normal text-muted-foreground/65">/{rollup.total}</span>
          </span>
        )}
      </span>

      <span className="col-start-2 col-span-3 font-mono text-meta truncate -mt-0.5">
        {empty ? <span className="text-muted-foreground/70">nothing points at it yet</span> : subtitle(rollup)}
      </span>
    </button>
  )
}
