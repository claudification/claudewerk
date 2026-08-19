/**
 * The rig both wall suites share: open the surface, wait for every lazily
 * imported stub to land, then reach into the DOM by pane code.
 *
 * Split out of `wall-surface.test.tsx` so neither suite crosses the 150-line
 * bar this card ships the chrome for.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { WallModal } from './wall-modal'
import { WALL_PANE_CODES } from './wall-pane-registry'
import { openWall, useWallStore } from './wall-state'

export const store = () => useModalManagerStore.getState()

export function wallRoot(doc: Document = document): HTMLElement {
  const root = doc.querySelector('.wall-root')
  if (!root) throw new Error('the wall never mounted')
  return root as HTMLElement
}

export function pane(code: string, doc: Document = document): HTMLElement | null {
  return doc.querySelector(`[data-pane="${code}"]`)
}

/**
 * Open the surface and wait for every lazily-imported pane to land.
 *
 * It waits on the PANE ELEMENTS, not on the stub's "no feed yet" line: that
 * counted the panes that had not been built yet, so the rig broke the first time
 * a pane card shipped a real feed (A8) -- a passing test suite failing because
 * somebody delivered.
 */
export async function openTheWall(): Promise<void> {
  act(() => {
    openWall()
  })
  render(<WallModal />)
  await waitFor(() => expect(document.querySelectorAll('[data-pane]')).toHaveLength(WALL_PANE_CODES.length))
}

/** Registered by each suite so a leaked modal record or a stuck ambient flag
 *  cannot bleed from one test into the next. */
export function installWallTestHooks(): void {
  beforeEach(() => {
    useModalManagerStore.setState({ records: {} })
    useWallStore.setState({ ambient: false })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
}
