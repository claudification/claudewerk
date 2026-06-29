/**
 * ModalSurface -- the universal host that routes a managed modal's body to where
 * it currently lives: an inline Radix Dialog, the dock (renders nothing here --
 * the tile is in <Dock>), or its OWN OS window via the PopoutWindow primitive.
 *
 * The consuming component stays mounted at the app shell and holds its own state;
 * because ModalSurface only re-targets WHERE the body portals, switching
 * inline <-> docked <-> detached preserves in-progress state for free. The
 * standard chrome (minimize / maximize / detach|reattach / close) lives here, so
 * every adopting modal gets identical window controls.
 */

import { ExternalLink, Maximize2, Minimize2, Minus, Shrink, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { getDetachedWindow, type ManagedModal } from '@/hooks/use-modal-manager'
import { cn } from '@/lib/utils'
import { PopoutWindow } from './popout/popout-window'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

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

function ChromeButton({ onClick, title, children }: { onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="text-muted-foreground hover:text-foreground transition-colors"
    >
      {children}
    </button>
  )
}

function MinimizeButton({ modal }: { modal: ManagedModal }) {
  if (!modal.minimizable) return null
  return (
    <ChromeButton onClick={modal.minimize} title="Minimize to dock">
      <Minus className="size-4" />
    </ChromeButton>
  )
}

/** Detached window: minimize / reattach / close (no Dialog X to dodge). */
function DetachedControls({ modal, onClose }: { modal: ManagedModal; onClose?: () => void }) {
  return (
    <div className="ml-auto flex items-center gap-3">
      <MinimizeButton modal={modal} />
      {modal.minimizable && (
        <ChromeButton onClick={modal.reattach} title="Re-attach into the app">
          <Shrink className="size-3.5" />
        </ChromeButton>
      )}
      <ChromeButton onClick={onClose ?? modal.close} title="Close">
        <X className="size-4" />
      </ChromeButton>
    </div>
  )
}

/** Inline dialog: minimize / maximize / detach. mr-6 clears the Dialog's own X. */
function InlineControls({ modal }: { modal: ManagedModal }) {
  return (
    <div className="ml-auto mr-6 flex items-center gap-3">
      <MinimizeButton modal={modal} />
      <ChromeButton onClick={modal.toggleMaximize} title={modal.maximized ? 'Restore size' : 'Maximize'}>
        {modal.maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </ChromeButton>
      {modal.minimizable && (
        <ChromeButton onClick={modal.detach} title="Detach to its own window">
          <ExternalLink className="size-3.5" />
        </ChromeButton>
      )}
    </div>
  )
}

function SurfaceHeader({
  modal,
  title,
  icon,
  headerExtra,
  detached,
  onClose,
}: {
  modal: ManagedModal
  title: string
  icon?: ReactNode
  headerExtra?: ReactNode
  detached: boolean
  onClose?: () => void
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
      {icon}
      {detached ? (
        <span className="text-xs font-bold text-primary">{title}</span>
      ) : (
        <DialogTitle className="text-xs">{title}</DialogTitle>
      )}
      {headerExtra}
      {detached ? <DetachedControls modal={modal} onClose={onClose} /> : <InlineControls modal={modal} />}
    </div>
  )
}

// fallow-ignore-next-line complexity
export function ModalSurface({ modal, title, icon, headerExtra, className, onClose, children }: ModalSurfaceProps) {
  const handleClose = onClose ?? modal.close
  // Detached: portal the body into its own OS window. The window was opened in
  // the detach() gesture and lives in the manager registry; closing it via its
  // own chrome parks the modal to the dock (state survives).
  if (modal.presentation === 'detached') {
    const win = getDetachedWindow(modal.id)
    if (!win) return null
    return (
      <PopoutWindow win={win} title={title} onClose={modal.parkFromDetached}>
        <div className="flex h-screen w-screen flex-col bg-background text-foreground">
          <SurfaceHeader modal={modal} title={title} icon={icon} headerExtra={headerExtra} detached onClose={onClose} />
          {children}
        </div>
      </PopoutWindow>
    )
  }

  // Docked renders nothing here -- the dock owns the tile, the component stays
  // mounted (state preserved). Inline renders the Radix Dialog.
  return (
    <Dialog
      open={modal.presentation === 'inline'}
      onOpenChange={o => {
        if (!o) handleClose()
      }}
    >
      <DialogContent className={cn('flex flex-col p-0', modal.maximized ? MAXIMIZED_CONTENT : className)}>
        <SurfaceHeader
          modal={modal}
          title={title}
          icon={icon}
          headerExtra={headerExtra}
          detached={false}
          onClose={onClose}
        />
        {children}
      </DialogContent>
    </Dialog>
  )
}
