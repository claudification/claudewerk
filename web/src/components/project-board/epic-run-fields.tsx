/**
 * The RUN dialog's three fields. Split out when the dialog crossed the .tsx line
 * budget -- and the split is real, not cosmetic: the dialog owns SUBMISSION (the
 * request, the busy flag, the error) and this owns the CHOICES.
 */

import { cn } from '@/lib/utils'
import { firstBeat, type RunPlan } from './epic-run-plan'
import type { RunSettings as RunSettings_ } from './use-run-settings'

const CADENCES = [
  { value: 'now' as const, label: 'now', hint: 'Dispatch immediately, ignore the clock' },
  { value: 'window' as const, label: 'window', hint: "Defer dispatch to the project's night window" },
]

const TARGETS = [
  { value: 'pr' as const, label: 'pr', hint: 'Green on a branch, raised for review. Nothing reaches main.' },
  { value: 'merged' as const, label: 'merged', hint: 'Integrated to main, main stays green. Still revertible.' },
  {
    value: 'shipped' as const,
    label: 'shipped',
    // The one choice on this dialog you cannot take back, and it was whispering
    // it in the same grey as the two you can.
    hint: 'Deployed by the fleet, unreviewed, while you are not watching.',
    alarming: true,
  },
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
  /** `alarming` marks a choice you cannot undo -- its hint is shown in the
   *  destructive tone, the same treatment concurrency-past-5 gets. */
  options: ReadonlyArray<{ value: T; label: string; hint: string; alarming?: boolean }>
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
      {active && (
        <span
          className={cn('text-chrome leading-snug', active.alarming ? 'text-destructive' : 'text-muted-foreground/70')}
        >
          {active.hint}
        </span>
      )}
    </div>
  )
}

/** All three, in the order they narrow the decision: when, how far, how wide. */
export function RunSettings({ settings, plan }: { settings: RunSettings_; plan: RunPlan }) {
  const { options, setCadence, setTarget, setConcurrency } = settings
  return (
    <>
      <Choice label="cadence" options={CADENCES} value={options.cadence} onChange={setCadence} />
      <Choice label="target" options={TARGETS} value={options.target} onChange={setTarget} />
      <ConcurrencyField value={options.concurrency} plan={plan} onChange={setConcurrency} />
    </>
  )
}

/**
 * Concurrency, with a WARNING past 5 rather than a cap.
 *
 * The supervision ceiling is a property of REVIEW, not of the machine: everyone
 * who runs more than a handful of agents got there by giving up per-change
 * review. The board's job is to make that visible, not to forbid it and not to
 * help you exceed it quietly.
 */
function ConcurrencyField({ value, plan, onChange }: { value: number; plan: RunPlan; onChange: (v: number) => void }) {
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
      {/* What the number DOES to this epic, not what the field is called. Raising
          it past the ready count buys nothing, and the old copy hid that. */}
      <span className="text-chrome text-muted-foreground/70 leading-snug">{beatLine(plan, value)}</span>
      {value > REVIEW_CEILING && (
        <span className="text-chrome text-destructive leading-snug">
          Past {REVIEW_CEILING} you are choosing to stop reviewing per-change. The ceiling is a property of review, not
          of the machine.
        </span>
      )}
    </div>
  )
}

function beatLine(plan: RunPlan, concurrency: number): string {
  const going = firstBeat(plan, concurrency)
  if (plan.ready === 0) return 'Nothing is ready -- every live card is waiting on a dependency.'
  if (going < plan.ready) return `Beat 1 dispatches ${going} of ${plan.ready} ready; the rest wait for a free slot.`
  const all = plan.ready === 1 ? 'the 1 ready card' : `all ${plan.ready} ready cards`
  const spare = concurrency > plan.ready ? ` ${concurrency - plan.ready} slot(s) go unused.` : ''
  return `Beat 1 dispatches ${all} at once.${spare}`
}
