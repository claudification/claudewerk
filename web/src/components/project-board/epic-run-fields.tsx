/**
 * The RUN dialog's three fields. Split out when the dialog crossed the .tsx line
 * budget -- and the split is real, not cosmetic: the dialog owns SUBMISSION (the
 * request, the busy flag, the error) and this owns the CHOICES.
 */

import type { StartEpicOptions } from '@/lib/epic-run-api'
import { cn } from '@/lib/utils'

const CADENCES = [
  { value: 'now' as const, label: 'now', hint: 'Dispatch immediately, ignore the clock' },
  { value: 'window' as const, label: 'window', hint: "Defer dispatch to the project's night window" },
]

const TARGETS = [
  { value: 'pr' as const, label: 'pr', hint: 'Green on a branch, raised for review' },
  { value: 'merged' as const, label: 'merged', hint: 'Integrated to main, main stays green' },
  { value: 'shipped' as const, label: 'shipped', hint: 'Deployed. Crosses the irreversible line' },
]

/** The soft ceiling. Not a cap -- see the warning copy for why. */
const REVIEW_CEILING = 5

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: ReadonlyArray<{ value: T; label: string; hint: string }>
  value: T
  onChange: (v: T) => void
}) {
  const active = options.find(o => o.value === value)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-chrome font-mono text-muted-foreground/70">{label}</span>
      <div className="flex gap-1">
        {options.map(o => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              'px-2 py-1 text-[10px] font-mono border transition-colors',
              o.value === value
                ? 'border-[color:var(--epic-edge)] text-foreground bg-[color:var(--epic-tint)]'
                : 'border-border/60 text-muted-foreground/80 hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {active && <span className="text-chrome text-muted-foreground/70">{active.hint}</span>}
    </div>
  )
}

export function CadenceChoice({
  value,
  onChange,
}: {
  value: StartEpicOptions['cadence']
  onChange: (v: StartEpicOptions['cadence']) => void
}) {
  return <Choice label="cadence" options={CADENCES} value={value} onChange={onChange} />
}

export function TargetChoice({
  value,
  onChange,
}: {
  value: StartEpicOptions['target']
  onChange: (v: StartEpicOptions['target']) => void
}) {
  return <Choice label="target" options={TARGETS} value={value} onChange={onChange} />
}

/**
 * Concurrency, with a WARNING past 5 rather than a cap.
 *
 * The supervision ceiling is a property of REVIEW, not of the machine: everyone
 * who runs more than a handful of agents got there by giving up per-change
 * review. The board's job is to make that visible, not to forbid it and not to
 * help you exceed it quietly.
 */
export function ConcurrencyField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-chrome font-mono text-muted-foreground/70">concurrency</span>
      <input
        type="number"
        min={1}
        max={10}
        value={value}
        onChange={e => onChange(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
        className="w-20 px-2 py-1 text-[11px] font-mono bg-transparent border border-border/60 text-foreground"
      />
      {value > REVIEW_CEILING ? (
        <span className="text-chrome text-destructive leading-snug">
          Past {REVIEW_CEILING} you are choosing to stop reviewing per-change. The ceiling is a property of review, not
          of the machine.
        </span>
      ) : (
        <span className="text-chrome text-muted-foreground/70">Implementers in flight at once. 3 is the default.</span>
      )}
    </div>
  )
}
