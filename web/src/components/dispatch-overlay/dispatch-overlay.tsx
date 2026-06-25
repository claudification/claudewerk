import { lazy, Suspense, useEffect } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { DispatchFlow } from './dispatch-flow'
import { DispatchHeader } from './dispatch-header'
import { DispatchIntentInput } from './dispatch-intent-input'
import { useDispatchStore } from './dispatch-store'
import './dispatch.css'

// Lazy: the verbose state panel only loads when first toggled on (LAZY LOAD covenant).
const DispatchVerbose = lazy(() => import('./dispatch-verbose'))

/**
 * The dispatch desk -- a light-touch concierge that fronts everything. You tell
 * it what you need in plain words; it figures out who and takes you there. A
 * calm centred column (works on a phone), not a fleet dashboard. Lazy-mounted
 * via the arming bus; Esc or the scrim dismisses it.
 */
export default function DispatchOverlay() {
  const open = useDispatchStore(s => s.open)
  const close = useDispatchStore(s => s.closeOverlay)
  const verbose = useDispatchStore(s => s.verbose)
  const fetchThreads = useDispatchStore(s => s.fetchThreads)
  // Subscribes to connectSeq only (bumps on every WS (re)connect), NOT the data.
  const connectSeq = useConversationsStore(s => s.connectSeq)

  // Self-heal the open-load: re-fetch the desk when the overlay is open and the
  // socket (re)connects. Covers cold-open (the overlay armed before the WS was
  // OPEN, so openOverlay's initial fetchThreads silently dropped and left the desk
  // blank) and any mid-session reconnect. fetchThreads no-ops while already
  // loading, so the redundant mount-time call is free. Mirrors project-list.tsx.
  useEffect(() => {
    if (open) fetchThreads()
  }, [open, connectSeq, fetchThreads])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])

  if (!open) return null

  // data-state="open" makes key-layers.ts yield Escape to us (its dialog-dismiss
  // guard matches [role="dialog"][data-state="open"]); without it the global
  // Escape->go-home command eats the key and the overlay never closes.
  return (
    <div role="dialog" aria-modal="true" aria-label="Dispatch" data-state="open">
      <button type="button" aria-label="Close dispatch" tabIndex={-1} className="dispatch-scrim" onClick={close} />
      <div className="dispatch-deck">
        <DispatchHeader />
        {verbose && (
          <Suspense fallback={null}>
            <DispatchVerbose />
          </Suspense>
        )}
        <DispatchFlow />
        <DispatchIntentInput />
      </div>
    </div>
  )
}
