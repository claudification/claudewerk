import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '@/lib/utils'
import { usePopoutContainer } from '../popout/popout-container-context'

function Dialog({ modal, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  // Inside a detached PopoutWindow, force NON-modal. Radix's modal machinery
  // (RemoveScroll scroll-lock, `pointer-events: none` on body, focus trap,
  // aria-hidden) is applied to the GLOBAL/opener document -- so a modal dialog
  // portaled into the popout freezes the MAIN window (dead scroll + clicks) and
  // the focus trap fights across documents. modal={false} keeps all of that off;
  // we render our own backdrop for the modal look. An explicit `modal` wins.
  const popout = usePopoutContainer()
  return <DialogPrimitive.Root data-slot="dialog" modal={modal ?? (popout ? false : undefined)} {...props} />
}

function _DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ container, ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  // Inside a detached PopoutWindow, target its body so the dialog stays in the
  // popout instead of jumping to the opener window. Explicit container wins.
  const popout = usePopoutContainer()
  return <DialogPrimitive.Portal data-slot="dialog-portal" container={container ?? popout ?? undefined} {...props} />
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  // In a popout the dialog is non-modal, so Radix's own Overlay renders nothing
  // (it only mounts for modal dialogs) and its cross-document outside-click
  // detection is unreliable. Draw our OWN backdrop as a Close target: clicking
  // the dim area dismisses the dialog -- same "click outside to close" UX as the
  // inline modal, but scoped to the popout window so the opener never freezes.
  const popout = usePopoutContainer()
  return (
    <DialogPortal>
      {popout ? (
        <DialogPrimitive.Close asChild>
          <button
            type="button"
            aria-label="Close"
            data-slot="dialog-overlay"
            className="fixed inset-0 z-50 cursor-default bg-black/80"
          />
        </DialogPrimitive.Close>
      ) : (
        <DialogOverlay />
      )}
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]',
          'w-[90vw] max-w-3xl max-h-[85vh]',
          'border border-border bg-background shadow-lg',
          'flex flex-col',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-3 top-3 text-muted-foreground hover:text-foreground transition-colors">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-sm font-bold text-primary', className)}
      {...props}
    />
  )
}

export { Dialog, DialogContent, DialogTitle }
