/**
 * WHO IS WORKING, and WHO IS PLANNING ABOVE THEM.
 *
 * The overseer block is separate from the seats block and always rendered, even
 * -- especially -- when the lease is null. The first live run of this engine
 * dispatched two implementers and never woke an overseer, and the only way to
 * find that out was to curl the API and notice `lease: null` in the JSON. A
 * missing planner has to be LOUD, so it gets its own block with its own
 * explanation rather than being an absence you might not notice.
 */

import type { EpicInspectConversation, EpicInspectLive } from '@shared/protocol'
import { cn, haptic } from '@/lib/utils'
import { Block } from './overseer-bits'

const ROLE_TONE: Record<string, string> = {
  implementer: 'text-primary border-primary/50',
  verifier: 'text-active border-[color:var(--active)]/50',
  overseer: 'text-[color:var(--epic-badge)] border-[color:var(--epic-badge-edge)]',
}

const ROLE_LABEL: Record<string, string> = { implementer: 'IMPL', verifier: 'VERIF', overseer: 'OVER' }

function Seat({ conv, onOpen }: { conv: EpicInspectConversation; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic('tap')
        onOpen(conv.id)
      }}
      className="w-full flex items-center gap-2 px-1.5 py-1.5 mb-1 border border-border hover:border-[color:var(--epic-badge-edge)] hover:bg-[color:var(--epic-badge-tint)] transition-colors text-left"
    >
      <span
        className={cn(
          'text-chrome px-1 border shrink-0',
          ROLE_TONE[conv.role] ?? 'text-muted-foreground border-border',
        )}
      >
        {ROLE_LABEL[conv.role] ?? conv.role.slice(0, 5).toUpperCase()}
      </span>
      <span className="flex-1 min-w-0 text-[11px] truncate">{conv.cardId ?? conv.id.slice(0, 8)}</span>
      <span className={cn('text-meta shrink-0', conv.live ? 'text-active' : 'text-fg-dim')}>
        {conv.live ? `gen ${conv.gen}` : conv.status}
      </span>
    </button>
  )
}

export function OverseerSeats({
  live,
  concurrency,
  onOpenConversation,
}: {
  live: EpicInspectLive
  concurrency: number
  onOpenConversation: (id: string) => void
}) {
  const working = live.conversations.filter(c => c.role !== 'overseer' && c.live)
  const overseer = live.conversations.find(c => c.role === 'overseer')

  return (
    <>
      <Block title="Seats" extra={<span>{`${working.length} / ${concurrency}`}</span>}>
        {working.length === 0 ? (
          <div className="text-[11px] text-fg-dim italic">No seat is working right now.</div>
        ) : (
          working.map(c => <Seat key={c.id} conv={c} onOpen={onOpenConversation} />)
        )}
      </Block>

      <Block title="Overseer">
        {overseer ? (
          <Seat conv={overseer} onOpen={onOpenConversation} />
        ) : (
          <div className="px-1.5 py-1.5 border border-dashed border-destructive/40 text-[11px] text-destructive">
            never woken . lease null
          </div>
        )}
        {!overseer && (
          <div className="text-meta text-fg-dim mt-1.5">
            Seats are working with nothing planning above them. BEAT NOW forces the engine to take the lease and wake
            one.
          </div>
        )}
        {live.generationMismatch && <div className="text-meta text-destructive mt-1.5">{live.generationMismatch}</div>}
        {!live.armed && (
          <div className="text-meta text-idle mt-1.5">
            Not in the sweep's armed set -- the broker restarted and forgot it. RESUME re-arms.
          </div>
        )}
      </Block>
    </>
  )
}
