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
import { WALL_PANE_CODES, WALL_PANE_ENTRIES } from './wall-pane-registry'
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
 * Pull every pane module through the loader ONCE, before any suite mounts.
 *
 * `LAZY LOAD` is one of the epic's covenant lines -- the surface and every pane
 * arrive through a dynamic `import()` -- so a grid that is transiently a pane or
 * two short is the wall keeping its promise, not breaking one. The only question
 * a mount test can honestly ask is "did they all land", never "did they all land
 * within N milliseconds".
 *
 * The rig used to ask the second question by accident. `waitFor`'s budget is
 * 1000ms, and the FIRST `openTheWall()` in a file paid Vite's transform for all
 * fourteen pane modules inside it. Alone that is ~0.5s and always fit; under a
 * full-suite run (400+ files transforming at once) it crossed the second and the
 * grid was counted at twelve of fourteen. Which is exactly the failure that was
 * observed: one red test per file, always the first one, ~25% of full runs, and
 * never once when `src/components/wall/` ran on its own.
 *
 * Awaiting the registry's own `load`s moves that transform OUT of the polling
 * window and under the test's own timeout, where slow is slow instead of red,
 * and leaves `waitFor` measuring nothing but React committing lazy components
 * whose promises are already resolved. Cached in a module-scope promise, so the
 * suite's second mount and its twentieth cost nothing.
 *
 * NOT a raised timeout. A bigger number would have bought headroom against the
 * load that was measured and nothing against the next machine; this removes the
 * machine from the assertion instead.
 */
let paneChunks: Promise<unknown> | null = null
function warmPaneChunks(): Promise<unknown> {
  paneChunks ??= Promise.all(WALL_PANE_ENTRIES.map(entry => entry.load()))
  return paneChunks
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
  await warmPaneChunks()
  act(() => {
    openWall()
  })
  render(<WallModal />)
  // Named, not counted. `expected length 13, got 12` sent the last investigation
  // looking for a pane it had no way to identify; the missing CODES say straight
  // out which stub never mounted.
  await waitFor(() => expect(missingPanes()).toEqual([]))
}

/** The registry codes with no element on the surface right now. */
function missingPanes(): string[] {
  const mounted = new Set([...document.querySelectorAll('[data-pane]')].map(el => el.getAttribute('data-pane')))
  return WALL_PANE_CODES.filter(code => !mounted.has(code))
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
