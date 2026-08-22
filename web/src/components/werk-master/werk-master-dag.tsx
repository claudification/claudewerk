/**
 * WHAT THE DAG SAYS SHOULD HAPPEN NEXT -- pure `planEpic`, no model involved.
 *
 * `idleReason` is rendered FIRST and loudest. "Nothing is dispatching" is the
 * question every stalled run raises, and the broker already computes the answer;
 * burying it under the card list would be hiding the one line worth reading.
 */

import type { EpicInspectCard, EpicInspectPlan } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { Block } from './werk-master-bits'

/** Lane -> glyph + tone. A map rather than a chain: five lanes on one key. */
const LANES: { key: keyof EpicInspectPlan; glyph: string; tone: string; label: string }[] = [
  { key: 'dispatch', glyph: '●', tone: 'text-active', label: 'ready' },
  { key: 'verify', glyph: '◐', tone: 'text-primary', label: 'verify' },
  { key: 'questions', glyph: '?', tone: 'text-event-prompt', label: 'asks' },
  { key: 'heldBack', glyph: '○', tone: 'text-idle', label: 'held' },
  { key: 'waitingOnDeps', glyph: '○', tone: 'text-fg-faint', label: 'waiting' },
]

function CardLine({ card, glyph, tone, label }: { card: EpicInspectCard; glyph: string; tone: string; label: string }) {
  const waiting = card.waitingOn?.length
    ? `← ${card.waitingOn.length === 1 ? card.waitingOn[0] : `${card.waitingOn.length} cards`}`
    : label

  return (
    <div className="flex items-center gap-2 py-0.5 text-[11px]">
      <span className={cn('w-2.5 text-center shrink-0', tone)}>{glyph}</span>
      <span className={cn('flex-1 min-w-0 truncate', label === 'waiting' && 'text-fg-dim')}>{card.id}</span>
      <span className="text-meta text-fg-dim shrink-0">{waiting}</span>
    </div>
  )
}

export function WerkMasterDag({ plan }: { plan: EpicInspectPlan | null }) {
  if (!plan) {
    return (
      <Block title="DAG">
        <div className="text-[11px] text-fg-dim italic">No card on the board carries or claims this epic.</div>
      </Block>
    )
  }

  const lanes = LANES.map(lane => ({ ...lane, cards: (plan[lane.key] as EpicInspectCard[]) ?? [] })).filter(
    l => l.cards.length > 0,
  )

  return (
    <Block title="DAG" extra={<span>{plan.children} cards</span>}>
      {plan.idleReason && (
        <div className="text-[11px] text-idle border-l-2 border-[color:var(--idle)]/50 pl-2 mb-2">
          {plan.idleReason}
        </div>
      )}
      {plan.complete && <div className="text-[11px] text-active mb-2">Every card is done.</div>}
      {lanes.length === 0 && !plan.idleReason && (
        <div className="text-[11px] text-fg-dim italic">Nothing in any lane.</div>
      )}
      {lanes.map(lane =>
        lane.cards.map(card => (
          <CardLine key={`${lane.key}-${card.id}`} card={card} glyph={lane.glyph} tone={lane.tone} label={lane.label} />
        )),
      )}
    </Block>
  )
}
