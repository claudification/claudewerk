/**
 * The layer follows its ANCHOR, including into another window.
 *
 * THE WALL detaches into a popup and its DOM lives in that popup's document. A
 * layer hardcoded to `document.body` would portal a wall row's preview into the
 * dashboard -- behind the window you are looking at, positioned against a
 * viewport that is not the one the row is in. That failure is invisible in the
 * inline case, which is the only case anything else tests, so it gets its own.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { closeCardHover, useCardHover } from './card-hover-bus'
import { CardHoverLayer } from './card-hover-layer'

const FACTS = { kicker: 'pulse', title: 'a conversation', facts: [['host', 'studio'] as [string, string]] }

afterEach(() => {
  cleanup()
  closeCardHover()
})

function showOn(anchor: HTMLElement): void {
  act(() => {
    useCardHover.getState().show({ kind: 'facts', facts: FACTS }, anchor)
  })
}

describe('CardHoverLayer', () => {
  it('renders the facts panel next to an anchor in this document', () => {
    const anchor = document.createElement('div')
    document.body.append(anchor)
    render(<CardHoverLayer />)

    showOn(anchor)

    expect(screen.getByRole('tooltip')).toBeTruthy()
    expect(screen.getByText('studio')).toBeTruthy()
  })

  it('PORTALS INTO THE DOCUMENT THE ANCHOR LIVES IN, not this one', () => {
    const popup = document.implementation.createHTMLDocument('detached wall')
    const anchor = popup.createElement('div')
    popup.body.append(anchor)
    render(<CardHoverLayer />)

    showOn(anchor)

    expect(popup.querySelector('[role="tooltip"]')).toBeTruthy()
    // The dashboard's own document stays clean -- the panel is not off-screen
    // in the opener, it is in the window the row is in.
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('renders nothing once the hover is closed', () => {
    const anchor = document.createElement('div')
    document.body.append(anchor)
    render(<CardHoverLayer />)
    showOn(anchor)

    act(() => closeCardHover())

    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
