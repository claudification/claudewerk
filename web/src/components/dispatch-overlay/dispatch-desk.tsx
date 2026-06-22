import { formatAge, truncate } from '@/lib/utils'
import { useDispatchStore } from './dispatch-store'

/** "On my desk right now" -- the couple of threads the concierge is actively
 *  holding (its near-memory). Light, not a list of everything. */
export function DispatchDesk() {
  const threads = useDispatchStore(s => s.threads)
  if (threads.length === 0) return null

  return (
    <div className="px-6 pt-8">
      <span className="text-[11px] uppercase tracking-[0.2em] text-comment">on my desk right now</span>
      <div className="mt-3 flex flex-col gap-2">
        {threads.slice(0, 4).map(t => (
          <div key={t.id} className="rounded-xl border border-border/70 bg-card/40 px-3.5 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[13px] font-medium text-foreground/90">{t.title}</span>
              <span className="flex-none text-[10px] text-comment/70">{formatAge(t.updatedAt)}</span>
            </div>
            {t.summary && (
              <span className="mt-0.5 block text-[11.5px] leading-snug text-comment">{truncate(t.summary, 130)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
