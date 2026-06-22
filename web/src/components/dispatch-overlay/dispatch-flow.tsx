import { useEffect, useRef } from 'react'
import { DispatchDesk } from './dispatch-desk'
import { DispatchGreeting } from './dispatch-greeting'
import { DispatchMessage } from './dispatch-message'
import { useDispatchStore } from './dispatch-store'

/** The desk's scrollable body. Empty = the concierge greets you + shows what's
 *  on its desk. Once you talk, it becomes a calm back-and-forth (oldest first,
 *  newest at the bottom), with a quiet "…" while it thinks. */
export function DispatchFlow() {
  const decisions = useDispatchStore(s => s.decisions)
  const pending = useDispatchStore(s => s.pending)
  const lastError = useDispatchStore(s => s.lastError)
  const endRef = useRef<HTMLDivElement>(null)

  // chat order: oldest at top, newest at bottom
  const ordered = [...decisions].reverse()

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to newest on change
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [decisions.length, pending])

  return (
    <div className="dispatch-scroll min-h-0 flex-1 overflow-y-auto">
      {decisions.length === 0 ? (
        <>
          <DispatchGreeting />
          <DispatchDesk />
        </>
      ) : (
        <div className="flex flex-col gap-7 py-6">
          {ordered.map(d => (
            <DispatchMessage key={d.decisionId} decision={d} />
          ))}
        </div>
      )}

      {pending && (
        <p className="px-6 pb-4 text-[13px] text-comment">
          <span
            className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full align-middle"
            style={{ background: 'var(--accent)' }}
          />
          one sec…
        </p>
      )}
      {lastError && (
        <p className="mx-6 mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2 text-[12.5px] text-destructive">
          {lastError}
        </p>
      )}
      <div ref={endRef} />
    </div>
  )
}
