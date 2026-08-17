/**
 * Column width, body lines, density, title size.
 *
 * Extracted from `project-board.tsx` when that file crossed the split bar.
 * Nothing here is navigation -- it is all about how tightly the same cards are
 * drawn, which is why it lives behind a toggle rather than in the header.
 */

import { RotateCcw } from 'lucide-react'
import type { BoardViewConfig } from '@/hooks/use-board-view-config'
import { cn, haptic } from '@/lib/utils'
import { CHIP_IDLE } from './board-constants'

type Update = <K extends keyof BoardViewConfig>(key: K, value: BoardViewConfig[K]) => void

function ChipRow<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: readonly T[]
  value: T
  onPick: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-meta font-mono text-muted-foreground/70 w-16 shrink-0">{label}</span>
      <div className="flex gap-1 flex-1">
        {options.map(o => (
          <button
            key={o}
            type="button"
            onClick={() => onPick(o)}
            className={cn(
              'flex-1 px-2 py-0.5 text-chrome font-mono border rounded transition-colors',
              value === o ? 'border-accent/60 text-accent bg-accent/10' : CHIP_IDLE,
            )}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-meta font-mono text-muted-foreground/70 w-16 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 accent-accent"
      />
      <span className="text-meta font-mono tabular-nums text-foreground w-10 text-right">{display}</span>
    </label>
  )
}

export function ViewConfigPanel({ view, update, reset }: { view: BoardViewConfig; update: Update; reset: () => void }) {
  return (
    <div className="border border-border/70 bg-surface-inset/60 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-chrome font-mono uppercase text-muted-foreground/60">View</span>
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            reset()
          }}
          className="flex items-center gap-1 text-chrome font-mono text-muted-foreground/60 hover:text-foreground transition-colors"
          title="Reset to defaults"
        >
          <RotateCcw className="size-3" />
          Reset
        </button>
      </div>

      <SliderRow
        label="Width"
        value={view.columnWidth}
        min={200}
        max={400}
        step={10}
        display={`${view.columnWidth}px`}
        onChange={v => update('columnWidth', v)}
      />
      <SliderRow
        label="Body"
        value={view.bodyLines}
        min={0}
        max={6}
        step={1}
        display={view.bodyLines === 0 ? 'hidden' : `${view.bodyLines}L`}
        onChange={v => update('bodyLines', v)}
      />
      <ChipRow
        label="Density"
        options={['compact', 'normal', 'roomy'] as const}
        value={view.density}
        onPick={d => update('density', d)}
      />
      <ChipRow
        label="Title"
        options={['xs', 'sm'] as const}
        value={view.titleSize}
        onPick={s => update('titleSize', s)}
      />
    </div>
  )
}
