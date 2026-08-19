/**
 * The close X sits on the SAME ROW as the rest of the window chrome.
 *
 * It did not. Measured on the Overseer window: the X rendered 6 CSS px below the
 * minimize / maximize / detach glyphs and 43 px to the right of them, when the
 * glyphs themselves sit ~15 px apart. Two independent causes:
 *
 *   1. DialogContent reserves the corner on its first child (`pr-11`) AND
 *      InlineControls hand-reserved it again (`mr-6`) -- doubled gutter.
 *   2. The Dialog's `top-2.5` centres a 24px box on a ~44px header row; the
 *      surface title bar is 32px, so the X hung low.
 *
 * jsdom has no layout engine, so these are CLASS assertions -- they pin the two
 * declarations that produced the measured offsets, not the pixels themselves.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useManagedModal, useModalManagerStore } from '@/hooks/use-modal-manager'
import { ModalSurface } from '../modal-surface'

const OPTS = { id: 'chrome-probe', kind: 'probe', title: 'Probe' }

function Host() {
  const modal = useManagedModal(OPTS)
  if (modal.presentation === 'closed') return null
  return (
    <ModalSurface modal={modal} title="Probe">
      <div>body</div>
    </ModalSurface>
  )
}

function openInline() {
  act(() => {
    useModalManagerStore.getState().open(OPTS, { type: 'global' })
  })
  render(<Host />)
}

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
})
afterEach(cleanup)

describe('inline surface chrome', () => {
  it('re-centres the dialog close button on the 32px title bar', () => {
    openInline()
    const close = document.querySelector('[data-slot=dialog-close]')
    expect(close).not.toBeNull()
    // The override lives on the dialog, targeting the slot.
    const content = document.querySelector('[data-slot=dialog-content]')
    expect(content?.className).toContain('[&_[data-slot=dialog-close]]:top-1')
  })

  it('does not hand-reserve the close corner a second time', () => {
    openInline()
    const controls = screen.getByTitle('Maximize').parentElement
    expect(controls?.className).toContain('ml-auto')
    // `mr-6` here stacks on the dialog's own `pr-11` and strands the X.
    expect(controls?.className).not.toContain('mr-6')
  })
})
