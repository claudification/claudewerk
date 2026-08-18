/**
 * ModalSurface -- the universal host that routes a managed modal's body to where
 * it currently lives: an inline Radix Dialog, the dock (parked offscreen, still
 * running), or its OWN OS window via the PopoutWindow primitive.
 *
 * The body is NOT re-rendered into each host. It mounts once into the surface's
 * canvas (`SurfaceBody`, a fixed position in the React tree) and the canvas is
 * moved into whichever host slot is live (`SurfaceSlot`). React never sees the
 * portal container change, so in-progress state -- local state, timers, in-flight
 * fetches, stream subscriptions, scroll offsets -- survives every transition.
 * See surface/surface-canvas.ts for why this replaced the old render-per-host
 * approach (it silently remounted, and a parked Vacuum run lost its work).
 *
 * The chrome (surface/surface-chrome.tsx) renders per host, so each window gets
 * its own title bar and controls.
 */

import type { ReactNode } from 'react'
import { getDetachedWindow, type ManagedModal } from '@/hooks/use-modal-manager'
import { cn } from '@/lib/utils'
import { PopoutWindow } from './popout/popout-window'
import { SurfaceBody } from './surface/surface-body'
import { SurfaceHeader } from './surface/surface-chrome'
import { SurfaceSlot } from './surface/surface-slot'
import { Dialog, DialogContent } from './ui/dialog'

interface ModalSurfaceProps {
  modal: ManagedModal
  title: string
  /** Leading glyph in the title bar. */
  icon?: ReactNode
  /** Extra title-bar content between the title and the controls (e.g. a conv id). */
  headerExtra?: ReactNode
  /** Inline (non-maximized) DialogContent sizing classes. */
  className?: string
  /** Override the default close. When set, all close gestures (Dialog X, chrome
   *  button, Escape) call this instead of `modal.close()`. The caller owns the
   *  close lifecycle -- call `modal.close()` inside when you're ready to drop
   *  the record. Use this for surfaces that need custom teardown (e.g. live
   *  dialogs emitting a close event before removing the UI). */
  onClose?: () => void
  children: ReactNode
}

/** When maximized, the inline dialog fills the viewport. */
const MAXIMIZED_CONTENT = 'left-0 top-0 h-screen w-screen max-w-none max-h-screen translate-x-0 translate-y-0'

/** The body slot takes the space under the header in every host. */
const BODY_SLOT = 'flex min-h-0 flex-1 flex-col'

type HostProps = Omit<ModalSurfaceProps, 'children'>

/** The window that currently shows the body. Docked renders no host at all -- the
 *  canvas stays parked in the stash and the dock owns the tile. */
function SurfaceHost({ modal, title, icon, headerExtra, className, onClose }: HostProps) {
  const handleClose = onClose ?? modal.close
  const header = (detached: boolean) => (
    <SurfaceHeader
      modal={modal}
      title={title}
      icon={icon}
      headerExtra={headerExtra}
      detached={detached}
      onClose={onClose}
    />
  )

  if (modal.presentation === 'detached') {
    const win = getDetachedWindow(modal.id)
    if (!win) return null
    return (
      <PopoutWindow win={win} title={title} onClose={modal.parkFromDetached}>
        <div className="flex h-screen w-screen flex-col bg-background text-foreground">
          {header(true)}
          <SurfaceSlot id={modal.id} className={BODY_SLOT} />
        </div>
      </PopoutWindow>
    )
  }

  return (
    <Dialog
      open={modal.presentation === 'inline'}
      onOpenChange={o => {
        if (!o) handleClose()
      }}
    >
      <DialogContent className={cn('flex flex-col p-0', modal.maximized ? MAXIMIZED_CONTENT : className)}>
        {header(false)}
        <SurfaceSlot id={modal.id} className={BODY_SLOT} />
      </DialogContent>
    </Dialog>
  )
}

/** The document the body is currently displayed in, for nested Radix portals.
 *  null unless detached -- inline and docked both live in the main document. */
function hostContainer(modal: ManagedModal): HTMLElement | null {
  if (modal.presentation !== 'detached') return null
  return getDetachedWindow(modal.id)?.document.body ?? null
}

export function ModalSurface({ children, ...host }: ModalSurfaceProps) {
  if (host.modal.presentation === 'closed') return null
  return (
    <>
      {/* Fixed tree position -- the body mounts here once, for the whole life of
          the surface, and only its canvas moves between hosts. Which window it is
          being SHOWN in has to be handed down explicitly: the canvas move is DOM,
          and React context does not travel with it. */}
      <SurfaceBody id={host.modal.id} container={hostContainer(host.modal)}>
        {children}
      </SurfaceBody>
      <SurfaceHost {...host} />
    </>
  )
}
