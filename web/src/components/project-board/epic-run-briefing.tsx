/**
 * What the engine is being handed, above the settings that shape it.
 *
 * The dialog asked three questions and described nothing. Arming a fleet on
 * `werk-epic` told you the epic's id and no more -- not how many cards, not how
 * many could start, not what a beat even is. All of it is already in the rollup
 * the button was holding, so none of this costs a request.
 */

import { cn } from '@/lib/utils'
import type { RunPlan } from './epic-run-plan'

function Count({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className={cn('font-mono text-read tabular-nums leading-none', tone)}>{value}</span>
      <span className="font-mono text-chrome text-fg-dim">{label}</span>
    </span>
  )
}

/** The shape of the work, then one line on what the engine does with it. */
export function RunBriefing({ plan }: { plan: RunPlan }) {
  return (
    <div className="flex flex-col gap-2 pb-1">
      <div className="flex items-end gap-4">
        <Count value={plan.ready} label="READY" tone="text-active" />
        {plan.waiting > 0 && <Count value={plan.waiting} label="WAITING ON DEPS" tone="text-event-prompt" />}
        {plan.done > 0 && <Count value={plan.done} label="DONE" tone="text-fg-muted" />}
        {plan.dropped > 0 && <Count value={plan.dropped} label="DROPPED" tone="text-fg-dim" />}
      </div>
      <p className="font-mono text-chrome text-fg-muted leading-relaxed">
        Each beat dispatches one implementer per ready card in <code className="text-foreground">depends_on</code>{' '}
        order, sends an independent verifier over everything finished, then wakes one overseer. It runs unattended until
        the epic is done or it needs you.
      </p>
      <OrderingCaveat waiting={plan.waiting} />
    </div>
  )
}

/**
 * The limit of the ordering, said out loud.
 *
 * Readiness is arithmetic over `depends_on` (`epic-ready.ts`) and nothing else
 * looks at it -- the overseer is explicitly NOT the dispatcher. So two cards that
 * touch the same thing without a declared edge go out together and collide, and
 * the overseer can only add that edge on the NEXT beat, after the damage. A
 * dialog that shows a confident ready-count owes you the caveat behind it.
 */
function OrderingCaveat({ waiting }: { waiting: number }) {
  return (
    <p className="font-mono text-chrome text-fg-dim leading-relaxed">
      Ordering is only as good as the declared edges: cards with no{' '}
      <code className="text-fg-muted">depends_on</code> between them dispatch together even if they collide.
      {waiting > 0 ? ' The overseer can add a missing edge, but only between beats.' : ' Nothing here declares one.'}
    </p>
  )
}

/** The three choices resolved into the single sentence you are agreeing to. */
export function RunConsequence({ text, irreversible }: { text: string; irreversible: boolean }) {
  return (
    <p
      className={cn(
        'font-mono text-chrome leading-relaxed border-l-2 pl-2.5',
        irreversible ? 'border-destructive/60 text-destructive' : 'border-[color:var(--epic-edge)] text-foreground/85',
      )}
    >
      {text}
    </p>
  )
}
