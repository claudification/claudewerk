/**
 * Epic rollup strip: one bar, three segments, one counts line.
 *
 * `dropped` (archived / won't-fix) is NOT in the bar and NOT in the denominator
 * -- an epic whose children were all abandoned must read "0 of 0", never the
 * lie "100%". It gets a word at the end of the counts line instead.
 */

import { CARD_STATE_STYLE, type CardProgress } from '@/lib/cards'
import { cn } from '@/lib/utils'

const SEGMENTS = [
  { key: 'done', state: 'done', label: 'done' },
  { key: 'active', state: 'active', label: 'running' },
  { key: 'todo', state: 'todo', label: 'open' },
] as const

export function CardEpicProgress({ progress }: { progress?: CardProgress }) {
  if (!progress) {
    return <div className="mt-2 h-1.5 w-full rounded-full bg-muted-foreground/20 animate-pulse" aria-hidden="true" />
  }
  const { total, pct, dropped } = progress
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted-foreground/15">
          {total > 0 &&
            SEGMENTS.map(seg => {
              const width = (progress[seg.key] / total) * 100
              if (width <= 0) return null
              return (
                <div
                  key={seg.key}
                  style={{ width: `${width}%` }}
                  className={cn('h-full', CARD_STATE_STYLE[seg.state].fill)}
                />
              )
            })}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground shrink-0">
          {progress.done}/{total}
          {pct !== null && ` · ${pct}%`}
        </span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
        {SEGMENTS.map(seg => (
          <span key={seg.key} className={cn(progress[seg.key] > 0 && CARD_STATE_STYLE[seg.state].text)}>
            {progress[seg.key]} {seg.label}
            {' · '}
          </span>
        ))}
        <span>{dropped} dropped</span>
      </div>
    </div>
  )
}
