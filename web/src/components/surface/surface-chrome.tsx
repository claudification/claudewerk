/**
 * The window chrome every managed surface gets for free: title bar, owner glyph,
 * and the minimize / maximize / detach|reattach / close controls.
 *
 * Split out of modal-surface.tsx so that file stays about ROUTING the body
 * (canvas -> host slot) and this one stays about the buttons.
 */

import { ExternalLink, Maximize2, Minimize2, Minus, Shrink, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ManagedModal } from '@/hooks/use-modal-manager'
import { DialogTitle } from '../ui/dialog'

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

/** Inline dialog: minimize / maximize / detach. The Dialog's own X sits in the
 *  corner DialogContent already reserves on this header (`[&>*:first-child]:pr-11`),
 *  so no hand-rolled clearance here -- the `mr-6` that used to be on this row
 *  DOUBLED it and pushed the X 24px off the end of the cluster. Same leftover
 *  ModalWindowControls dropped for the same reason. */
function InlineControls({ modal }: { modal: ManagedModal }) {
  return (
    <div className="ml-auto flex items-center gap-3">
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

export function SurfaceHeader({
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
