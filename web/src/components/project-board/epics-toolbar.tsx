/**
 * The EPICS view's own controls.
 *
 * The count line that used to live here is gone -- the allocation strip above
 * says the same thing to scale, and saying it twice in two formats was how the
 * old header ended up reading "7 epics · 0 parented · 402 unparented" like an
 * error message. What is left is sorting and one filter.
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
  /** LIVE unparented only. The archive is not a backlog. */
  looseLiveCount: number
  sort: EpicSort
  onSort: (sort: EpicSort) => void
  showComplete: boolean
  onShowComplete: (value: boolean) => void
}

export function EpicsToolbar(props: EpicsToolbarProps) {
  return (
    <div className="flex items-center gap-x-4 gap-y-1 flex-wrap px-3 py-1.5 border-b border-border shrink-0">
      <span className="text-meta font-mono text-fg-muted">
        <span className="text-foreground tabular-nums">{props.epicCount}</span> epics ·{' '}
        <span className="text-foreground tabular-nums">{props.parentedCount}</span> parented ·{' '}
        <span className="text-foreground tabular-nums">{props.looseLiveCount}</span> loose &amp; live
      </span>

      <div className="flex items-center gap-1 ml-auto">
        <span className="text-chrome font-mono text-fg-dim">SORT</span>
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
              'px-1.5 py-0.5 text-meta font-mono transition-colors',
              props.sort === s.key ? 'bg-accent/20 text-accent' : 'text-fg-muted hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => {
          haptic('tap')
          props.onShowComplete(!props.showComplete)
        }}
        className={cn(
          'px-1.5 py-0.5 text-meta font-mono border transition-colors',
          props.showComplete
            ? 'border-accent/40 text-accent bg-accent/10'
            : 'border-border text-fg-muted hover:text-foreground',
        )}
      >
        show finished
      </button>
    </div>
  )
}
