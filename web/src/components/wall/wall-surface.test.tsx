/**
 * THE WALL's shell. Four properties, and every one of them is a thing the epic
 * would be broken without:
 *
 *  - the hard grid mounts, with every pane's chrome (title + reference code)
 *  - the body survives a detach, because it is a managed surface and not a
 *    hand-rolled Dialog (the covenant modal-surface.test.tsx exists to defend)
 *  - `A` toggles ambient and `Esc` leaves it, on the wall's OWN document
 *  - ambient does not remount anything -- the same DOM nodes come back
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { WallModal } from './wall-modal'
import { WALL_PANES } from './wall-pane-registry'
import { openWall, useWallStore, WALL_MODAL } from './wall-state'

const store = () => useModalManagerStore.getState()

function wallRoot(doc: Document = document): HTMLElement {
  const root = doc.querySelector('.wall-root')
  if (!root) throw new Error('the wall never mounted')
  return root as HTMLElement
}

/** Open the surface and wait for the lazily-imported pane bodies to land. */
async function openTheWall() {
  act(() => {
    openWall()
  })
  render(<WallModal />)
  await waitFor(() => expect(screen.getAllByText('no feed yet')).toHaveLength(WALL_PANES.length))
}

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
  useWallStore.setState({ ambient: false })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the wall shell', () => {
  it('opens from openWall() with the whole hard grid in it', async () => {
    await openTheWall()

    // "THE WALL" twice on purpose: the managed surface's title bar names it, and
    // so does the wall's own brand. Pin the one inside the body.
    expect(wallRoot().querySelector('.wall-brand b')?.textContent).toBe('THE WALL')
    for (const pane of WALL_PANES) {
      expect(screen.getByText(pane.title)).toBeTruthy()
      expect(wallRoot().querySelector(`[data-pane="${pane.code}"]`)).toBeTruthy()
    }
  })

  it('lays the panes out in three columns, with only the third scrolling', async () => {
    await openTheWall()
    const columns = wallRoot().querySelectorAll('.wall-col')

    expect(columns).toHaveLength(3)
    expect(columns[0].classList.contains('wall-col-scroll')).toBe(false)
    expect(columns[2].classList.contains('wall-col-scroll')).toBe(true)
    // Column C is the stack the mockup gives six panes.
    expect(columns[2].querySelectorAll('.wall-pane')).toHaveLength(6)
  })

  it('renders a pane caption in the header count slot', async () => {
    await openTheWall()
    const burn = wallRoot().querySelector('[data-pane="A2"]')

    expect(burn?.querySelector('.wall-pane-count')?.textContent).toBe('last 60m')
    expect(burn?.querySelector('.wall-pane-code')?.textContent).toBe('A2')
  })

  it('moves its body into the detached window without losing the grid', async () => {
    const doc = document.implementation.createHTMLDocument('wall popout')
    const fakeWin = { document: doc, focus: vi.fn(), close: vi.fn(), closed: false }
    vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window)

    await openTheWall()
    const before = wallRoot()

    act(() => {
      store().detach(WALL_MODAL.id)
    })
    // Same node, other document: moved, not re-rendered from scratch.
    expect(wallRoot(doc)).toBe(before)
    expect(doc.querySelectorAll('.wall-pane')).toHaveLength(WALL_PANES.length)

    act(() => {
      store().reattach(WALL_MODAL.id)
    })
    expect(wallRoot()).toBe(before)
  })

  it('toggles ambient with A and leaves it with Escape', async () => {
    await openTheWall()
    const root = wallRoot()

    fireEvent.keyDown(document, { key: 'A' })
    expect(root.dataset.ambient).toBe('true')
    expect(screen.getByText('EXIT AMBIENT')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(root.dataset.ambient).toBeUndefined()
    expect(screen.getByText('AMBIENT')).toBeTruthy()
  })

  it('ignores A while the user is typing', async () => {
    await openTheWall()
    const input = document.createElement('input')
    document.body.appendChild(input)

    fireEvent.keyDown(input, { key: 'a' })
    expect(wallRoot().dataset.ambient).toBeUndefined()
    input.remove()
  })

  it('hides the SOTU pane in ambient and keeps every other pane mounted', async () => {
    await openTheWall()
    const sotu = wallRoot().querySelector('[data-pane="A4"]')
    const pulseBefore = wallRoot().querySelector('[data-pane="P1"]')

    expect(sotu?.classList.contains('wall-hide-ambient')).toBe(true)

    fireEvent.keyDown(document, { key: 'a' })
    // Ambient is a class flip, not a re-mount: the same nodes are still there,
    // which is what "restores without losing pane state" actually means.
    expect(wallRoot().querySelector('[data-pane="P1"]')).toBe(pulseBefore)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(wallRoot().querySelector('[data-pane="P1"]')).toBe(pulseBefore)
    expect(wallRoot().querySelectorAll('.wall-pane')).toHaveLength(WALL_PANES.length)
  })

  it('drops ambient when the surface is parked to the dock', async () => {
    await openTheWall()
    fireEvent.keyDown(document, { key: 'a' })
    expect(useWallStore.getState().ambient).toBe(true)

    act(() => {
      store().minimize(WALL_MODAL.id)
    })
    expect(useWallStore.getState().ambient).toBe(false)
  })
})
