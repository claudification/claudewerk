import { cn, haptic } from '@/lib/utils'
import { FORK_STRATEGIES, FORK_STRATEGY_ORDER, type ForkStrategy } from './fork-strategy'

/** Radio list of the three fork strategies, each with its trade-off spelled out. */
export function StrategyPicker({
  value,
  onChange,
  disabled,
}: {
  value: ForkStrategy
  onChange: (v: ForkStrategy) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">Carry over</div>
      <div className="space-y-1">
        {FORK_STRATEGY_ORDER.map(key => {
          const spec = FORK_STRATEGIES[key]
          const active = value === key
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => {
                onChange(key)
                haptic('tick')
              }}
              className={cn(
                'w-full text-left px-2.5 py-2 rounded border transition-colors disabled:opacity-50',
                active
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-border hover:border-border hover:bg-surface-inset',
              )}
            >
              <div className={cn('text-[11px] font-mono font-bold', active ? 'text-primary' : 'text-foreground')}>
                {spec.label}
              </div>
              <div className="text-[9px] text-comment leading-snug mt-0.5">{spec.hint}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
