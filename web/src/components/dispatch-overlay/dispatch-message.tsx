import type { DispatchCandidate, DispatchDecision } from '@shared/protocol'
import { cn, truncate } from '@/lib/utils'
import { useDispatchStore } from './dispatch-store'

/** A warm dot marking the concierge's "voice". */
function Mark() {
  return <span className="mt-1.5 inline-block h-2 w-2 flex-none rounded-full" style={{ background: 'var(--accent)' }} />
}

function Candidate({ c, onPick }: { c: DispatchCandidate; onPick(): void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex flex-col gap-1 rounded-2xl border border-border bg-card/60 px-4 py-3 text-left transition-colors hover:border-[color-mix(in_oklch,var(--accent)_50%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[14px] font-medium text-foreground">
          {c.title || c.project || c.conversationId.slice(0, 8)}
        </span>
        <span className="flex-none text-[12px]" style={{ color: 'var(--accent)' }}>
          take me here
        </span>
      </div>
      {c.commentary && <span className="text-[12.5px] leading-snug text-comment">{truncate(c.commentary, 140)}</span>}
    </button>
  )
}

/** One concierge exchange, rendered LIGHT: what you asked, the concierge's
 *  plain-words reply, and at most a gentle option. No disposition labels, no
 *  confidence meters -- the routing is real, the UI just doesn't show its gears. */
export function DispatchMessage({ decision: d }: { decision: DispatchDecision }) {
  const routeTo = useDispatchStore(s => s.routeTo)
  const confirmExpensive = useDispatchStore(s => s.confirmExpensive)
  const target = d.resultConversationId ?? (d.disposition === 'new' ? undefined : d.target)

  return (
    <div className="flex flex-col gap-3 px-6">
      <p className="text-[13px] leading-relaxed text-comment">
        <span className="text-comment/50">you · </span>
        {d.intent}
      </p>

      <div className="flex gap-2.5">
        <Mark />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* converse -> the concierge's actual answer (d.reply); otherwise the
              one-line human rationale. The routing gears stay hidden. */}
          <p className="text-[14px] leading-relaxed text-foreground/90">{d.reply ?? d.reasoning}</p>

          {d.disposition === 'ask' && d.candidates && d.candidates.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {d.candidates.map(c => (
                <Candidate key={c.conversationId} c={c} onPick={() => routeTo(c.conversationId)} />
              ))}
            </div>
          )}

          {d.awaitingConfirmation && (
            <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card/50 px-4 py-3">
              {d.cost?.note && <span className="text-[12.5px] text-comment">Heads up: {d.cost.note}.</span>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => confirmExpensive(d)}
                  className="rounded-xl px-4 py-2 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ background: 'var(--accent)', color: 'var(--background)' }}
                >
                  Yes, go ahead
                </button>
                <span className="self-center text-[12px] text-comment/70">or just ask me something else</span>
              </div>
            </div>
          )}

          {!d.awaitingConfirmation && d.disposition !== 'ask' && target && (
            <button
              type="button"
              onClick={() => routeTo(target)}
              className={cn(
                'self-start rounded-xl border border-border px-4 py-2 text-[13px] text-foreground',
                'transition-colors hover:border-[color-mix(in_oklch,var(--accent)_50%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              take me there
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
