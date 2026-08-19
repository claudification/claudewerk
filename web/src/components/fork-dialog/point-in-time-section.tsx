/**
 * The point-in-time controls, shown only when the fork was started from a
 * specific message. A fork from the conversation header never renders this.
 */

import { cn } from '@/lib/utils'
import { FORK_DIRECTION_ORDER, FORK_DIRECTIONS, type ForkDirection, type ForkPointSeed } from './fork-point'

function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
  hint: string
}) {
  return (
    <label className={cn('flex gap-2 items-start cursor-pointer', disabled && 'opacity-40 cursor-not-allowed')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 accent-primary"
      />
      <span className="space-y-0.5">
        <span className="block text-[11px] font-mono text-foreground">{label}</span>
        <span className="block text-[9px] text-comment leading-snug">{hint}</span>
      </span>
    </label>
  )
}

export function PointInTimeSection({
  seed,
  direction,
  onDirectionChange,
  inclusive,
  onInclusiveChange,
  summarizeDropped,
  onSummarizeDroppedChange,
  disabled,
}: {
  seed: ForkPointSeed
  direction: ForkDirection
  onDirectionChange: (v: ForkDirection) => void
  inclusive: boolean
  onInclusiveChange: (v: boolean) => void
  summarizeDropped: boolean
  onSummarizeDroppedChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-2.5 rounded border border-primary/30 bg-primary/5 px-2.5 py-2">
      <div className="text-[11px] font-mono text-primary uppercase tracking-wide">Point in time</div>

      <div className="space-y-1">
        <div className="text-[9px] font-mono uppercase tracking-wide text-muted-foreground">
          {seed.role === 'user' ? 'Your message' : 'Assistant reply'}
        </div>
        <div className="rounded border border-border bg-surface-inset px-2 py-1.5">
          <p className="text-[10px] leading-relaxed text-muted-foreground font-mono line-clamp-4">
            {seed.preview || '(no text content)'}
          </p>
        </div>
        {/* An entry with no CC uuid still forks -- the sentinel falls back to the
            timestamp -- but the boundary can land on a neighbour, so say so. */}
        {!seed.uuid && (
          <div className="text-[9px] text-amber-400/80 leading-snug">
            This entry has no Claude Code id, so the cut is matched by timestamp and may land one message off.
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-[9px] font-mono uppercase tracking-wide text-muted-foreground">Carry over</div>
        <div className="grid grid-cols-2 gap-1.5">
          {FORK_DIRECTION_ORDER.map(value => {
            const spec = FORK_DIRECTIONS[value]
            const active = direction === value
            return (
              <button
                key={value}
                type="button"
                disabled={disabled}
                onClick={() => onDirectionChange(value)}
                className={cn(
                  'text-left rounded border px-2 py-1.5 transition-colors',
                  active ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground',
                  disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-primary/60',
                )}
              >
                <span className="block text-[10px] font-mono font-bold">{spec.label}</span>
                <span className="block mt-0.5 text-[9px] text-comment leading-snug">{spec.hint}</span>
              </button>
            )
          })}
        </div>
      </div>

      <Checkbox
        checked={inclusive}
        onChange={onInclusiveChange}
        disabled={disabled}
        label="Include this message"
        hint={
          direction === 'before'
            ? 'On: the fork ends with this message. Off: it stops just before it, so this turn can be retried.'
            : 'On: the fork starts with this message. Off: it starts with whatever came next.'
        }
      />

      <Checkbox
        checked={direction === 'after' && summarizeDropped}
        onChange={onSummarizeDroppedChange}
        disabled={disabled || direction === 'before'}
        label="Summarize the dropped history into one message"
        hint={
          direction === 'before'
            ? 'Only for Everything AFTER -- summarizing the turns you are about to redo would hand the fork the old answer.'
            : 'One fast-model paragraph standing in for the older turns, placed above the kept ones.'
        }
      />
    </div>
  )
}
