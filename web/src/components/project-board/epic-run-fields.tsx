/**
 * The RUN dialog's three fields. Split out when the dialog crossed the .tsx line
 * budget -- and the split is real, not cosmetic: the dialog owns SUBMISSION (the
 * request, the busy flag, the error) and this owns the CHOICES.
 */

import { cn } from '@/lib/utils'
import { firstBeat, type RunPlan } from './epic-run-plan'
import type { RunSettings as RunSettings_ } from './use-run-settings'

/**
 * THE `when` AXIS -- three exclusive buttons over a field that can hold a LIST.
 *
 * Deliberately single-select: composing gates ("not while another epic runs, and
 * only at night") is reachable from `epic_run action=start when=[window,queue]`
 * and is rare enough that three buttons plus a line saying what the run already
 * carries beats a multi-select nobody would use. Pressing one REPLACES the axis;
 * leaving it alone preserves it, which is what stops a resume un-queueing a run.
 */
const WHENS = [
  { value: 'now' as const, label: 'now', hint: 'Dispatch immediately, ignore the clock' },
  { value: 'window' as const, label: 'window', hint: "Defer dispatch to the project's night window" },
  {
    value: 'queue' as const,
    label: 'queue',
    hint:
      'Wait until no other epic in this project has work in flight, then hold the runner exclusively until this ' +
      'run goes dry. Everything else keeps verifying but stops dispatching while it holds.',
  },
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
  /** `null` when the current value is not one of the options -- a `when` axis
   *  carrying two gates lights no button, rather than lying about which one. */
  value: T | null
  onChange: (v: T) => void
}) {
  const active = options.find(o => o.value === value)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-chrome font-mono text-fg-muted">{label}</span>
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
                : 'border-border text-fg-muted hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {active && (
        <span className={cn('text-chrome leading-snug', active.alarming ? 'text-destructive' : 'text-fg-muted')}>
          {active.hint}
        </span>
      )}
    </div>
  )
}

/** All four, in the order they narrow the decision: what first, when, how far, how wide. */
export function RunSettings({ settings, plan }: { settings: RunSettings_; plan: RunPlan }) {
  const { options, setCadence, setTarget, setConcurrency, setPlan, planApplies } = settings
  return (
    <>
      {planApplies && <PlanField value={options.plan} onChange={setPlan} />}
      <Choice
        label="when"
        options={WHENS}
        value={options.cadence.length === 1 ? options.cadence[0] : null}
        onChange={setCadence}
      />
      {options.cadence.length > 1 && (
        <span className="text-chrome text-fg-muted leading-snug">
          {`This run carries ${options.cadence.join(' + ')} -- all of them must pass. Picking one above replaces both.`}
        </span>
      )}
      <Choice label="target" options={TARGETS} value={options.target} onChange={setTarget} />
      <ConcurrencyField value={options.concurrency} plan={plan} onChange={setConcurrency} />
    </>
  )
}

/**
 * GENERATION 0 -- the analysis pass, default on.
 *
 * It is first in the dialog because it happens first and because it changes what
 * every field below it operates on: the ordering the concurrency ceiling divides
 * up is the ordering this pass writes.
 */
function PlanField({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex flex-col gap-1 cursor-pointer">
      <span className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value}
          onChange={e => onChange(e.target.checked)}
          className="size-3 accent-[color:var(--epic-solid)]"
        />
        <span className="text-chrome font-mono text-foreground">Analyze and create execution plan</span>
      </span>
      <span className="text-chrome text-fg-muted leading-snug">
        {value
          ? 'One generation reads the epic and every card first: closes what is already done, files what is ' +
            'missing, and writes the depends_on edges nobody declared -- so the ordering above is complete before ' +
            'anything runs. If it changes your board, the run stops and shows you before dispatching.'
          : 'Dispatch straight against the board as it stands. Only the edges already declared will be honoured.'}
      </span>
    </label>
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
      <span className="text-chrome font-mono text-fg-muted">concurrency</span>
      <input
        type="number"
        min={1}
        max={10}
        value={value}
        onChange={e => onChange(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
        className="w-20 px-2 py-1 text-[11px] font-mono bg-transparent border border-border text-foreground"
      />
      {/* What the number DOES to this epic, not what the field is called. Raising
          it past the ready count buys nothing, and the old copy hid that. */}
      <span className="text-chrome text-fg-muted leading-snug">{beatLine(plan, value)}</span>
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
