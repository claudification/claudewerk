/**
 * W3, ambient mode:
 *
 *  - `A` toggles it and `Esc` leaves it, on the wall's OWN document
 *  - typing into the header filter is not a hotkey
 *  - the SOTU pane opts out, and nothing remounts -- the same DOM nodes come
 *    back, which is what "restores without losing pane state" actually means
 *  - parking the surface force-exits, so the dock cannot strand fullscreen
 *
 * The shell itself is `wall-surface.test.tsx`.
 */

import { fireEvent, screen } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { WALL_PANE_CODES } from './wall-pane-registry'
import { useWallStore, WALL_MODAL } from './wall-state'
import { installWallTestHooks, openTheWall, pane, store, wallRoot } from './wall-test-utils'

installWallTestHooks()

describe('the wall in ambient mode', () => {
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

  it('ignores A while the user is typing into the filter', async () => {
    await openTheWall()
    const filter = wallRoot().querySelector('.wall-filter input')

    fireEvent.keyDown(filter as Element, { key: 'a' })
    expect(wallRoot().dataset.ambient).toBeUndefined()
  })

  it('hides the SOTU pane in ambient and keeps every other pane mounted', async () => {
    await openTheWall()
    const pulseBefore = pane('P1')

    expect(pane('A4')?.classList.contains('wall-hide-ambient')).toBe(true)

    fireEvent.keyDown(document, { key: 'a' })
    // Ambient is a class flip, not a re-mount: the same nodes are still there.
    expect(pane('P1')).toBe(pulseBefore)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(pane('P1')).toBe(pulseBefore)
    expect(wallRoot().querySelectorAll('.wall-pane')).toHaveLength(WALL_PANE_CODES.length - 1)
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
