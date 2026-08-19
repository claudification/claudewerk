/**
 * THE WALL's shell -- the frame twelve pane cards mount into:
 *
 *  - all twelve pane stubs mount, lazily, with their chrome (title + code)
 *  - the hard grid is three columns and only the third scrolls
 *  - the inert header slots the filter and cursor cards will fill are there
 *  - the body survives a detach, because it is a managed surface and not a
 *    hand-rolled Dialog (the covenant modal-surface.test.tsx exists to defend)
 *
 * Ambient mode is `wall-ambient.test.tsx`.
 */

import { screen } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { WALL_PANE_CODES } from './wall-pane-registry'
import { WALL_MODAL } from './wall-state'
import { installWallTestHooks, openTheWall, pane, store, wallRoot } from './wall-test-utils'

installWallTestHooks()

describe('the wall shell', () => {
  it('opens from openWall() with all twelve pane stubs wired in', async () => {
    await openTheWall()

    // "THE WALL" twice on purpose: the managed surface's title bar names it, and
    // so does the wall's own brand. Pin the one inside the body.
    expect(wallRoot().querySelector('.wall-brand b')?.textContent).toBe('THE WALL')
    expect(WALL_PANE_CODES).toHaveLength(12)
    for (const code of WALL_PANE_CODES) expect(pane(code)).toBeTruthy()
    // Chrome, not just a mount: the pane says what it is and what to call it.
    expect(pane('P1')?.querySelector('.wall-pane-title')?.textContent).toBe('PULSE')
    expect(pane('P1')?.querySelector('.wall-pane-code')?.textContent).toBe('P1')
  })

  it('lays the panes out in three columns, with only the third scrolling', async () => {
    await openTheWall()
    const columns = wallRoot().querySelectorAll('.wall-col')

    expect(columns).toHaveLength(3)
    expect(columns[0].classList.contains('wall-col-scroll')).toBe(false)
    expect(columns[2].classList.contains('wall-col-scroll')).toBe(true)
    // Column C is the stack the mockup gives six panes.
    expect(columns[2].querySelectorAll('.wall-pane')).toHaveLength(6)
    // A5 is the strip above the grid, not a column pane.
    expect(wallRoot().querySelector('.wall-nowbar')).toBeTruthy()
    expect(pane('A5')?.closest('.wall-col')).toBeNull()
  })

  it('renders the header slots the filter and cursor cards will fill', async () => {
    await openTheWall()
    const root = wallRoot()

    expect(root.querySelector('.wall-filter input')).toBeTruthy()
    expect(root.querySelector('.wall-scrub input[type="range"]')).toBeTruthy()
    // LAYOUT drives the deferred configurable grid: present, and honest about it.
    expect(screen.getByText('LAYOUT').closest('button')?.disabled).toBe(true)
  })

  it('renders a pane caption in the header count slot', async () => {
    await openTheWall()

    expect(pane('A2')?.querySelector('.wall-pane-count')?.textContent).toBe('last 60m')
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
    expect(doc.querySelectorAll('.wall-pane')).toHaveLength(WALL_PANE_CODES.length - 1)
    // Nothing to detach to any more -- the surface's own bar offers re-attach.
    expect(screen.queryByText('DETACH')).toBeNull()

    act(() => {
      store().reattach(WALL_MODAL.id)
    })
    expect(wallRoot()).toBe(before)
    expect(screen.getByText('DETACH')).toBeTruthy()
  })
})
