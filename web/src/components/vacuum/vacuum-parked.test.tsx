/**
 * Parking the workbench must not throw the work away.
 *
 * The reported bug: park the Vacuum window mid-analysis, restore it, and it
 * comes back on "Measuring..." -- a fresh mount re-running the estimate against
 * a database it had already measured, while the run it was actually watching
 * carried on invisibly in the broker.
 *
 * The estimate is the input to a DESTRUCTIVE decision. Silently re-fetching it
 * underneath the user is exactly the failure `use-vacuum.ts` refuses to allow on
 * a timer, so it must not happen via a park either.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { vacuumEstimate } from './vacuum-estimate.fixture'
import { VacuumModal } from './vacuum-modal'
import { openVacuum } from './vacuum-state'

const store = () => useModalManagerStore.getState()

/** Fetch count for the estimate endpoint only -- plan/apply POSTs are separate. */
function estimateCalls(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter(c => String(c[0]).includes('/api/vacuum/estimate')).length
}

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('parking and restoring does NOT re-run the analysis', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(vacuumEstimate()), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  openVacuum()
  render(<VacuumModal />)
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Transcript history' })).toBeTruthy())
  expect(estimateCalls(fetchMock)).toBe(1)

  act(() => {
    store().minimize('vacuum')
  })
  act(() => {
    store().restore('vacuum')
  })

  // Restored onto the measurement it already had -- no second pass, no flash.
  expect(estimateCalls(fetchMock)).toBe(1)
  expect(screen.queryByText('Measuring...')).toBeNull()
  expect(screen.getByRole('checkbox', { name: 'Transcript history' })).toBeTruthy()
})

test('a selection made before parking is still there after restore', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(vacuumEstimate()), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  openVacuum()
  render(<VacuumModal />)
  const box = () => screen.getByRole('checkbox', { name: 'Transcript history' }) as HTMLInputElement
  await waitFor(() => expect(box()).toBeTruthy())

  // Transcripts default ON; untick it, park, restore -- the choice must survive.
  expect(box().checked).toBe(true)
  fireEvent.click(box())
  expect(box().checked).toBe(false)

  act(() => {
    store().minimize('vacuum')
  })
  act(() => {
    store().restore('vacuum')
  })

  expect(box().checked).toBe(false)
})
