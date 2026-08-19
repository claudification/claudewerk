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

/**
 * One definition of the dim, used by BOTH backdrops below. They used to carry
 * separate `bg-black/80` literals, so in a popout the two stacked and the page
 * behind went to #010204 -- past dim, into gone.
 */
const SCRIM = 'scrim-backdrop fixed inset-0 z-50'

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        SCRIM,
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
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
          <button type="button" aria-label="Close" data-slot="dialog-overlay" className={cn(SCRIM, 'cursor-default')} />
        </DialogPrimitive.Close>
      ) : (
        <DialogOverlay />
      )}
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]',
          'w-[90vw] max-w-3xl max-h-[85vh]',
          /* `bg-background` made the window fill IDENTICAL to the page fill --
             measured srgb(7,11,20) on both -- leaving one hairline to say a
             window was there at all. It gets its own rung now, plus the strong
             edge and the rim-light. */
          'border border-border-strong bg-popover elevation-window',
          'flex flex-col',
          /* RESERVE THE CLOSE BUTTON'S CORNER.
             The X below is absolutely positioned, so it floats OVER whatever
             occupies the top of the dialog. Every surface with full-width
             header content therefore had to remember to leave clearance --
             ModalWindowControls does it by hand with `mr-6` -- and the ones
             that forgot got the X sitting on top of their content. Settings
             was one: its filter input ran under the button and the focus ring
             collided with it.
             Reserving the gutter on the dialog's own first child makes it
             structural, so nothing downstream has to remember. */
          '[&>*:first-child]:pr-11',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-2.5 top-2.5 grid size-6 place-items-center rounded text-fg-muted transition-colors hover:bg-surface-hover hover:text-foreground">
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
