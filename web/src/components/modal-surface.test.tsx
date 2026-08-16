/**
 * The one property the DETACHABLE SURFACES covenant is sold on: a managed
 * surface's body mounts ONCE and survives every presentation flip.
 *
 * These tests exist because it did NOT. `docked` rendered `<Dialog open={false}>`
 * (Radix drops the whole DialogContent subtree) and `detached` returned an
 * entirely different tree, so the body remounted on every transition -- which is
 * how the parked Vacuum window came back re-running its analysis instead of
 * showing the run it still had going.
 *
 * The probe counts MOUNTS, not renders. A remount is the bug; re-rendering in a
 * new host is fine.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useManagedModal, useModalManagerStore } from '@/hooks/use-modal-manager'
import { ModalSurface } from './modal-surface'

let mounts = 0

function Probe() {
  const [n, setN] = useState(0)
  useEffect(() => {
    mounts += 1
  }, [])
  return (
    <div>
      <span data-testid="count">{n}</span>
      <button type="button" data-testid="inc" onClick={() => setN(v => v + 1)}>
        inc
      </button>
    </div>
  )
}

const OPTS = { id: 'probe', kind: 'probe', title: 'Probe' }

function Host() {
  const modal = useManagedModal(OPTS)
  if (modal.presentation === 'closed') return null
  return (
    <ModalSurface modal={modal} title="Probe">
      <Probe />
    </ModalSurface>
  )
}

const store = () => useModalManagerStore.getState()

/** Mount the surface inline and click the probe up to `n`. */
function openWithCount(n: number) {
  act(() => {
    store().open(OPTS, { type: 'global' })
  })
  render(<Host />)
  for (let i = 0; i < n; i++) fireEvent.click(screen.getByTestId('inc'))
  expect(screen.getByTestId('count').textContent).toBe(String(n))
}

function expectSurvived(count: string) {
  expect(mounts).toBe(1)
  expect(screen.getByTestId('count').textContent).toBe(count)
}

beforeEach(() => {
  mounts = 0
  useModalManagerStore.setState({ records: {} })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a managed surface body', () => {
  it('survives being parked to the dock, with its in-progress state', () => {
    openWithCount(3)
    act(() => {
      store().minimize('probe')
    })
    // Parked: still mounted, still holding its work.
    expectSurvived('3')
  })

  it('survives the round trip park -> restore without remounting', () => {
    openWithCount(3)
    act(() => {
      store().minimize('probe')
    })
    act(() => {
      store().restore('probe')
    })
    expectSurvived('3')
  })

  it('keeps counting while parked -- a parked surface is still live', () => {
    openWithCount(1)
    act(() => {
      store().minimize('probe')
    })
    fireEvent.click(screen.getByTestId('inc'))
    act(() => {
      store().restore('probe')
    })
    expectSurvived('2')
  })

  it('survives detach and re-attach', () => {
    const doc = document.implementation.createHTMLDocument('popout')
    const fakeWin = { document: doc, focus: vi.fn(), close: vi.fn(), closed: false }
    vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window)

    openWithCount(2)
    act(() => {
      store().detach('probe')
    })
    // The body physically moved into the other window's document -- same node,
    // same React component, no remount.
    expect(mounts).toBe(1)
    expect(doc.body.querySelector('[data-testid="count"]')?.textContent).toBe('2')

    act(() => {
      store().reattach('probe')
    })
    expectSurvived('2')
  })

  it('DOES unmount on close -- a closed surface is gone, not hidden', () => {
    openWithCount(2)
    act(() => {
      store().close('probe')
    })
    expect(screen.queryByTestId('count')).toBeNull()

    // Re-opening is a genuinely fresh body.
    act(() => {
      store().open(OPTS, { type: 'global' })
    })
    expect(mounts).toBe(2)
    expect(screen.getByTestId('count').textContent).toBe('0')
  })
})
