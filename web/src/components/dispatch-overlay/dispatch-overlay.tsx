import { lazy, Suspense, useEffect } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { DispatchFlow } from './dispatch-flow'
import { DispatchHeader } from './dispatch-header'
import { DispatchIntentInput } from './dispatch-intent-input'
import { MemoryEditorModal, RefinePreviewModal } from './dispatch-memory-editor'
import { SotuDumpModal } from './dispatch-sotu-modal'
import { useDispatchStore } from './dispatch-store'
import './dispatch.css'

// Lazy: the verbose state panel only loads when first toggled on (LAZY LOAD covenant).
const DispatchVerbose = lazy(() => import('./dispatch-verbose'))

/**
 * The dispatch desk -- a light-touch concierge that fronts everything. You tell
 * it what you need in plain words; it figures out who and takes you there.
 *
 * It is a PARKABLE, MAXIMIZABLE managed modal (folded into the global dock, same
 * as THE DIALOGUE / Nightshift): windowed by default so the conversation stays
 * visible alongside, a maximize toggle for the full canvas, and minimize-to-dock
 * so you can tuck it away and read the transcript/log behind it. Lazy-mounted via
 * the arming bus; once armed it stays mounted (parking keeps in-flight state).
 */
export default function DispatchOverlay() {
  const modal = useManagedModal({ id: 'dispatch', kind: 'dispatch', title: 'Dispatch' })
  const close = useDispatchStore(s => s.closeOverlay)
  const verbose = useDispatchStore(s => s.verbose)
  const fetchThreads = useDispatchStore(s => s.fetchThreads)
  // Subscribes to connectSeq only (bumps on every WS (re)connect), NOT the data.
  const connectSeq = useConversationsStore(s => s.connectSeq)
  const isOpen = modal.presentation === 'inline'

  // Self-heal the open-load: re-fetch the desk when the overlay is open and the
  // socket (re)connects. Covers cold-open (the overlay armed before the WS was
  // OPEN, so openOverlay's initial fetchThreads silently dropped and left the desk
  // blank) and any mid-session reconnect. fetchThreads no-ops while already
  // loading, so the redundant call is free. Mirrors project-list.tsx.
  useEffect(() => {
    if (isOpen) fetchThreads()
  }, [isOpen, connectSeq, fetchThreads])

  return (
    <Dialog open={isOpen} onOpenChange={o => o || close()}>
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          'gap-0 overflow-hidden p-0',
          modal.maximized
            ? 'left-0 top-0 h-screen w-screen max-w-none max-h-screen translate-x-0 translate-y-0 rounded-none'
            : 'h-[80vh] max-h-[84vh] w-[min(640px,92vw)] max-w-none rounded-[20px]',
        )}
      >
        <DialogTitle className="sr-only">Dispatch</DialogTitle>
        <DispatchHeader maximized={modal.maximized} onToggleMax={modal.toggleMaximize} onMinimize={modal.minimize} />
        {verbose && (
          <Suspense fallback={null}>
            <DispatchVerbose />
          </Suspense>
        )}
        <DispatchFlow />
        <DispatchIntentInput />
        <MemoryEditorModal />
        <RefinePreviewModal />
        <SotuDumpModal />
      </DialogContent>
    </Dialog>
  )
}
