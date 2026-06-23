import { lazy, Suspense, useEffect } from 'react'
import { DispatchFlow } from './dispatch-flow'
import { DispatchHeader } from './dispatch-header'
import { DispatchIntentInput } from './dispatch-intent-input'
import { DispatchScopeNote } from './dispatch-scope-note'
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

  return (
    <div role="dialog" aria-modal="true" aria-label="Dispatch">
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
        <DispatchScopeNote />
      </div>
    </div>
  )
}
