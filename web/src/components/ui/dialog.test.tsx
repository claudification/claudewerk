import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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
})
