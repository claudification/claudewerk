/**
 * The EPICS view's own controls, and the count line that keeps it honest.
 *
 * The summary is not decoration. Mid-adoption most of a board belongs to no
 * epic, and a view that opened on three tidy swimlanes read as "this is the
 * work" when it was 5% of it.
 */

import { cn, haptic } from '@/lib/utils'

export type EpicSort = 'urgency' | 'progress' | 'size' | 'name'

const EPIC_SORTS: Array<{ key: EpicSort; label: string; title: string }> = [
  { key: 'urgency', label: 'urgency', title: 'Most outstanding work first' },
  { key: 'progress', label: 'progress', title: 'Furthest along first' },
  { key: 'size', label: 'size', title: 'Most children first' },
  { key: 'name', label: 'name', title: 'Alphabetical by title' },
]

export interface EpicsToolbarProps {
  epicCount: number
  parentedCount: number
  unparentedCount: number
  sort: EpicSort
  onSort: (sort: EpicSort) => void
  showComplete: boolean
  onShowComplete: (value: boolean) => void
  allExpanded: boolean
  onToggleAll: () => void
}

export function EpicsToolbar(props: EpicsToolbarProps) {
  const { epicCount, parentedCount, unparentedCount } = props

  return (
    <div className="flex items-center gap-x-4 gap-y-1 flex-wrap px-3 py-1.5 border-b border-border/60 shrink-0">
      <span className="text-[10px] font-mono text-muted-foreground/70">
        <span className="text-foreground/80">{epicCount}</span> epics ·{' '}
        <span className="text-foreground/80">{parentedCount}</span> parented ·{' '}
        <span className={cn(unparentedCount > parentedCount ? 'text-event-prompt/80' : 'text-foreground/80')}>
          {unparentedCount}
        </span>{' '}
        unparented
      </span>

      <div className="flex items-center gap-1 ml-auto">
        <span className="text-[9px] font-mono text-muted-foreground/60 tracking-wider">SORT</span>
        {EPIC_SORTS.map(s => (
          <button
            key={s.key}
            type="button"
            title={s.title}
            onClick={() => {
              haptic('tap')
              props.onSort(s.key)
            }}
            className={cn(
              'px-1.5 py-0.5 text-[10px] font-mono transition-colors',
              props.sort === s.key ? 'bg-accent/20 text-accent' : 'text-muted-foreground/80 hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <ToolbarToggle
        active={props.showComplete}
        label="show finished"
        onClick={() => props.onShowComplete(!props.showComplete)}
      />
      <ToolbarToggle
        active={props.allExpanded}
        label={props.allExpanded ? 'collapse all' : 'expand all'}
        onClick={props.onToggleAll}
      />
    </div>
  )
}

function ToolbarToggle({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic('tap')
        onClick()
      }}
      className={cn(
        'px-1.5 py-0.5 text-[10px] font-mono border transition-colors',
        active
          ? 'border-accent/40 text-accent bg-accent/10'
          : 'border-border/60 text-muted-foreground/80 hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
}
