/**
 * The workbench body and the run log.
 *
 * The property that matters most here: a SKIPPED step is rendered WITH its
 * reason. A step that reports no reason is indistinguishable from one that
 * silently vanished, and that ambiguity is worst at exactly the moment rows are
 * already gone.
 */

import type { VacuumStepMessage } from '@shared/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RunLog } from './run-log'
import { VacuumModal } from './vacuum-modal'
import { openVacuum } from './vacuum-state'

afterEach(cleanup)

function step(overrides: Partial<VacuumStepMessage> = {}): VacuumStepMessage {
  return {
    type: 'vacuum_step',
    runId: 'ab12cd34',
    step: 'gate',
    status: 'ok',
    detail: 'verified backup-x.tar.zst, 40m old',
    rowsBefore: 1_256_089,
    rowsAfter: 1_256_089,
    dbBytesBefore: 10_000_000_000,
    dbBytesAfter: 10_000_000_000,
    initiator: 'user:jonas',
    dryRun: false,
    ts: 1,
    ...overrides,
  }
}

describe('the run log', () => {
  test('renders nothing before a run starts', () => {
    const { container } = render(<RunLog steps={[]} />)
    expect(container.firstChild).toBeNull()
  })

  test('shows a skipped step WITH its reason, never a bare skip', () => {
    render(
      <RunLog
        steps={[
          step({ step: 'delete', status: 'skipped', detail: 'confirmDelete not set -- archives written, rows kept' }),
        ]}
      />,
    )
    expect(screen.getByText(/confirmDelete not set/)).toBeTruthy()
  })

  test('marks a failure distinctly from a skip', () => {
    render(
      <RunLog
        steps={[
          step({ step: 'gate', status: 'failed', detail: 'last successful backup is 600m old' }),
          step({ step: 'archive:2026-05', status: 'skipped', detail: 'run aborted at the gate' }),
        ]}
      />,
    )
    expect(screen.getByText('XX')).toBeTruthy()
    expect(screen.getByText('--')).toBeTruthy()
  })

  test('labels a dry run as such so it is not mistaken for a real one', () => {
    render(<RunLog steps={[step({ dryRun: true })]} />)
    expect(screen.getByText('Dry run')).toBeTruthy()
  })

  test('reports the before/after totals once the run is done', () => {
    render(<RunLog steps={[step({ step: 'done', rowsAfter: 431_701, dbBytesAfter: 4_300_000_000 })]} />)
    expect(screen.getByText(/1,256,089 to 431,701 rows/)).toBeTruthy()
  })
})

describe('the workbench body', () => {
  beforeEach(() => {
    openVacuum()
  })

  test('surfaces a permission failure instead of rendering an empty panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    )
    render(<VacuumModal />)
    await waitFor(() => expect(screen.getByText(/Admin access required/)).toBeTruthy())
  })

  test('says so when the broker has no cache dir to reclaim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ configured: false }), { status: 200 })),
    )
    render(<VacuumModal />)
    await waitFor(() => expect(screen.getByText(/no cache directory to reclaim/i)).toBeTruthy())
  })
})
