/**
 * The reporting mirror.
 *
 * A surface body re-renders constantly; the dock must not. These pin that a
 * report only reaches the store when something a viewer would notice actually
 * changed, and that the hook stays silent for a surface passing `null`.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SurfaceActivityInput } from './modal-manager-types'
import { useModalManagerStore } from './use-modal-manager'
import { useSurfaceActivity } from './use-surface-activity'

const OPTS = { id: 'vacuum', kind: 'vacuum', title: 'Vacuum' }
const store = () => useModalManagerStore.getState()

function Reporter({ activity }: { activity: SurfaceActivityInput | null }) {
  useSurfaceActivity('vacuum', activity)
  return null
}

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
  store().open(OPTS, { type: 'global' })
})
afterEach(cleanup)

it('mirrors what the surface reports onto the record', () => {
  render(<Reporter activity={{ status: 'running', label: 'measuring', progress: 0.5, tick: 2 }} />)
  expect(store().records.vacuum?.activity).toMatchObject({ status: 'running', label: 'measuring', progress: 0.5 })
})

it('says nothing at all for a surface that reports null', () => {
  render(<Reporter activity={null} />)
  expect(store().records.vacuum?.activity).toBeUndefined()
})

it('does not write on a re-render that carries no news', () => {
  const spy = vi.spyOn(store(), 'reportActivity')
  const { rerender } = render(<Reporter activity={{ status: 'running', tick: 1 }} />)
  rerender(<Reporter activity={{ status: 'running', tick: 1 }} />)
  rerender(<Reporter activity={{ status: 'running', tick: 1 }} />)
  expect(spy).toHaveBeenCalledTimes(1)

  rerender(<Reporter activity={{ status: 'running', tick: 2 }} />)
  expect(spy).toHaveBeenCalledTimes(2)
  spy.mockRestore()
})
