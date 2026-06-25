import { useEffect, useRef } from 'react'
import { DispatchDesk } from './dispatch-desk'
import { DispatchGreeting } from './dispatch-greeting'
import { useDispatchStore } from './dispatch-store'
import { DispatchTail } from './dispatch-tail'
import { DispatchTranscript } from './dispatch-transcript'

/** The desk's scrollable body. Empty = the concierge greets you + shows what's on
 *  its desk. Otherwise it renders the STREAMED living history (the persistent
 *  conversation, the source of truth) plus a quiet in-flight tail. Decoupled from
 *  reloads -- the history is restored on open, never reset to blank. */
// fallow-ignore-next-line complexity
export function DispatchFlow() {
  const turns = useDispatchStore(s => s.history?.transcript)
  const hasDecisions = useDispatchStore(s => s.decisions.length > 0)
  const pending = useDispatchStore(s => s.pending)
  const endRef = useRef<HTMLDivElement>(null)

  const empty = !turns?.length && !hasDecisions

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to newest on change
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns?.length, hasDecisions, pending])

  // The tail (spinner / error / latest reply / affordances) ALWAYS mounts -- even
  // on a pristine, empty desk -- so the very first "ask" shows feedback instead of
  // going silent. Previously the empty branch dropped the tail entirely, so a first
  // message (or a dropped send) produced zero on-screen response: the dead-input feel.
  return (
    <div className="dispatch-scroll min-h-0 flex-1 overflow-y-auto">
      {empty ? (
        <>
          <DispatchGreeting />
          <DispatchDesk />
        </>
      ) : (
        <DispatchTranscript turns={turns ?? []} />
      )}
      <DispatchTail />
      <div ref={endRef} />
    </div>
  )
}
