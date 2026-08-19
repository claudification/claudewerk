/**
 * The left column of the EPICS view: every epic as one row, then the leftovers.
 *
 * Epics that hold work come first. Epics that are tagged but childless get
 * their own labelled section rather than being scattered among the real ones,
 * because "3 of your 7 epics are empty" is a fact about the board worth stating
 * once instead of seven times.
 *
 * The unattached pile is TWO first-class rows, not a footer warning. The live
 * one carries the only action; the finished one is dimmed and sorts last,
 * because nobody is ever going to parent a done card.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { cn, haptic } from '@/lib/utils'
import { EpicIndexRow } from './epic-index-row'

function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3.5 pb-1 font-mono text-chrome text-fg-dim">
      <span>{children}</span>
      <span className="flex-1 h-px bg-border/60" />
      {count !== undefined && <span className="tabular-nums">{count}</span>}
    </div>
  )
}

function LooseRow({
  label,
  count,
  detail,
  action,
  onAction,
  dimmed,
}: {
  label: string
  count: number
  detail: string
  action?: string
  onAction?: () => void
  dimmed?: boolean
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto_64px] gap-3 items-center px-3 py-2',
        'border-b border-border-subtle border-l-[3px] border-l-dashed border-l-muted-foreground/35',
        dimmed && 'opacity-60',
      )}
    >
      <span aria-hidden className="w-[1.15rem] text-center font-mono text-meta text-fg-dim">
        ●
      </span>
      <span className="font-mono text-read text-fg-muted truncate">{label}</span>
      {action && onAction ? (
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            onAction()
          }}
          className="font-mono text-chrome font-bold px-2 py-0.5 bg-accent text-background hover:opacity-85 transition-opacity"
        >
          {action}
        </button>
      ) : (
        <span />
      )}
      <span className="font-mono text-tally tabular-nums text-right text-foreground">{count}</span>
      <span className="col-start-2 col-span-3 font-mono text-meta text-fg-muted truncate -mt-0.5">{detail}</span>
    </div>
  )
}

export function EpicIndex({
  withWork,
  empty,
  selected,
  liveDetail,
  liveCount,
  finishedCount,
  finishedDetail,
  onSelect,
  onTriage,
}: {
  withWork: EpicRollup[]
  empty: EpicRollup[]
  selected: string | null
  liveCount: number
  liveDetail: string
  finishedCount: number
  finishedDetail: string
  onSelect: (epicId: string) => void
  onTriage: () => void
}) {
  const largest = Math.max(1, ...withWork.map(r => r.children.length))

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {withWork.length > 0 && <SectionLabel count={withWork.length}>EPICS WITH WORK IN THEM</SectionLabel>}
      {withWork.map(rollup => (
        <EpicIndexRow
          key={rollup.epicId}
          rollup={rollup}
          largest={largest}
          selected={selected === rollup.epicId}
          onSelect={onSelect}
        />
      ))}

      {empty.length > 0 && (
        <>
          <SectionLabel count={empty.length}>TAGGED epic, NOTHING POINTS AT THEM</SectionLabel>
          {empty.map(rollup => (
            <EpicIndexRow
              key={rollup.epicId}
              rollup={rollup}
              largest={largest}
              selected={selected === rollup.epicId}
              onSelect={onSelect}
            />
          ))}
        </>
      )}

      {(liveCount > 0 || finishedCount > 0) && <SectionLabel>EVERYTHING ELSE</SectionLabel>}
      {liveCount > 0 && (
        <LooseRow
          label="unattached -- live"
          count={liveCount}
          detail={liveDetail}
          action="TRIAGE"
          onAction={onTriage}
        />
      )}
      {finishedCount > 0 && (
        <LooseRow label="unattached -- finished" count={finishedCount} detail={finishedDetail} dimmed />
      )}
    </div>
  )
}
