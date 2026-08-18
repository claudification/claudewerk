/**
 * REGRESSION: a nested dialog opened from a DETACHED surface must stay in that
 * surface's window.
 *
 * Clicking a card in a detached Kanban board opened the editor in the MAIN
 * window. The cause is structural, not a Kanban bug: `SurfaceBody` renders at a
 * fixed position in the main React tree and only its canvas DOM node is moved
 * into the popout, so the `PopoutContainerContext` that `PopoutWindow` provides
 * never reached the body. Every nested Radix portal -- the card editor, LAUNCH,
 * RUN, every Select -- read `null` and portaled into the opener's document.
 *
 * The assertion is on the DOCUMENT the dialog lands in, because that is the
 * thing the user saw go wrong. The container-context probe pins the mechanism so
 * a future refactor cannot pass this by accident.
 */

import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useManagedModal, useModalManagerStore } from '@/hooks/use-modal-manager'
import { ModalSurface } from '../modal-surface'
import { usePopoutContainer } from '../popout/popout-container-context'
import { Dialog, DialogContent } from '../ui/dialog'

const OPTS = { id: 'portal-probe', kind: 'probe', title: 'Probe' }
const store = () => useModalManagerStore.getState()

/** A surface body that always has a nested dialog open, plus a readout of the
 *  portal container it believes it should use. */
function Host() {
  const modal = useManagedModal(OPTS)
  if (modal.presentation === 'closed') return null
  return (
    <ModalSurface modal={modal} title="Probe">
      <ContainerProbe />
      <Dialog open>
        <DialogContent>
          <span data-testid="nested">nested</span>
        </DialogContent>
      </Dialog>
    </ModalSurface>
  )
}

function ContainerProbe() {
  const container = usePopoutContainer()
  return <span data-testid="container">{container ? container.ownerDocument.title : 'main'}</span>
}

/** A stand-in popup: a real second HTMLDocument, which is what the portal cares about. */
function fakePopout() {
  const doc = document.implementation.createHTMLDocument('popout')
  const win = { document: doc, focus: vi.fn(), close: vi.fn(), closed: false }
  vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window)
  return doc
}

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('portals a nested dialog into the DETACHED window, not the opener', () => {
  const doc = fakePopout()
  act(() => {
    store().open(OPTS, { type: 'global' })
  })
  render(<Host />)

  // Inline: the opener owns it. This half must keep passing -- the fix must not
  // send main-window dialogs somewhere else.
  expect(document.body.querySelector('[data-testid="nested"]')).not.toBeNull()

  act(() => {
    store().detach('portal-probe')
  })

  expect(doc.body.querySelector('[data-testid="nested"]')).not.toBeNull()
  expect(document.body.querySelector('[data-testid="nested"]')).toBeNull()
  expect(doc.body.querySelector('[data-testid="container"]')?.textContent).toBe('popout')

  // Re-attaching hands it back, or the bug just moves in the other direction.
  act(() => {
    store().reattach('portal-probe')
  })
  expect(document.body.querySelector('[data-testid="nested"]')).not.toBeNull()
  expect(doc.body.querySelector('[data-testid="nested"]')).toBeNull()
})
