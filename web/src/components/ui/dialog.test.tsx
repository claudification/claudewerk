import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PopoutContainerContext } from '../popout/popout-container-context'
import { Dialog, DialogContent, DialogTitle } from './dialog'

afterEach(cleanup)

// Regression: a card editor opened from a DETACHED Kanban modal used to portal
// back to the opener window's document.body. With a popout container in context,
// the dialog must render inside that container instead.
describe('Dialog portal container (detached popout)', () => {
  it('portals into the provided popout container, not the main body', () => {
    const popout = document.createElement('div')
    popout.id = 'popout-body'
    document.body.appendChild(popout)

    const { container: renderRoot } = render(
      <PopoutContainerContext.Provider value={popout}>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Edit task</DialogTitle>
          </DialogContent>
        </Dialog>
      </PopoutContainerContext.Provider>,
    )

    expect(popout.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
    // It did NOT escape into the opener-window subtree (the RTL render root).
    expect(renderRoot.querySelector('[data-slot="dialog-content"]')).toBeNull()

    popout.remove()
  })

  it('defaults to the main document body when no popout container is provided', () => {
    const popout = document.createElement('div')
    document.body.appendChild(popout)

    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Edit task</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
    // Not inside the stray popout div (no context provided).
    expect(popout.querySelector('[data-slot="dialog-content"]')).toBeNull()

    popout.remove()
  })

  // Regression for the MAIN-WINDOW FREEZE: Radix's modal machinery binds to the
  // opener document -- it sets `pointer-events: none` on <body> (dead clicks) and
  // locks body scroll (`data-scroll-locked`). A dialog in a popout must be
  // NON-modal so the MAIN window keeps its scroll + clicks. These two body
  // signatures are exactly what froze the opener.
  it('leaves the opener window interactive when the dialog is in a popout', () => {
    const popout = document.createElement('div')
    document.body.appendChild(popout)

    render(
      <PopoutContainerContext.Provider value={popout}>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Edit task</DialogTitle>
          </DialogContent>
        </Dialog>
      </PopoutContainerContext.Provider>,
    )

    expect(document.body.style.pointerEvents).not.toBe('none')
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false)

    popout.remove()
  })

  it('stays modal (locks the opener) for a normal inline dialog', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Edit task</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(document.body.style.pointerEvents).toBe('none')
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true)
  })

  // "Click outside to dismiss" must work in a popout too. The dim backdrop is a
  // Close target, so clicking it closes the dialog (Radix's own outside-click
  // detection is unreliable across the popout document).
  it('dismisses when the popout backdrop is clicked', () => {
    const popout = document.createElement('div')
    document.body.appendChild(popout)
    const onOpenChange = vi.fn()

    render(
      <PopoutContainerContext.Provider value={popout}>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Edit task</DialogTitle>
          </DialogContent>
        </Dialog>
      </PopoutContainerContext.Provider>,
    )

    const backdrop = popout.querySelector('[data-slot="dialog-overlay"]')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as Element)
    expect(onOpenChange).toHaveBeenCalledWith(false)

    popout.remove()
  })
})
