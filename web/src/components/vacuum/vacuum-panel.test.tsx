/**
 * Tests for the destructive surface. The properties here are the ones that stop
 * someone deleting data on a wrong reading:
 *
 *   - "not measured" never renders as "0 B"
 *   - a failed backup gate disables APPLY and shows its literal reason
 *   - the confirm names the actual months and rows, not just a byte total
 *   - orphan rows are informational and cannot be ticked into a second delete
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApplyConfirm } from './apply-confirm'
import { describeBytes, formatBytes, formatMeasuredBytes } from './format'
import { VacuumFooter } from './vacuum-footer'
import { VacuumRows } from './vacuum-rows'
import { type BytesMeasurement, DEFAULT_SELECTION, type VacuumEstimate } from './vacuum-types'

afterEach(cleanup)

const MEASURED: BytesMeasurement = { provenance: 'measured', measuredAt: 'x', ageSeconds: 0, durationMs: 1 }
const UNMEASURED: BytesMeasurement = { provenance: 'unmeasured', measuredAt: '', ageSeconds: -1, durationMs: 0 }

function estimate(overrides: Partial<VacuumEstimate> = {}): VacuumEstimate {
  return {
    configured: true,
    measuredAt: '2026-08-14T00:00:00.000Z',
    measureDurationMs: 6000,
    bytes: MEASURED,
    hotDays: 30,
    gate: {
      ok: true,
      reason: 'verified backup-x.tar.zst, 40m old',
      backupArchive: 'backup-x.tar.zst',
      backupAgeMinutes: 40,
    },
    footprint: {
      fileBytes: 10_000_000_000,
      walBytes: 0,
      totalRows: 1_256_089,
      contentBytes: 6_270_000_000,
      ftsIndexBytes: 2_250_000_000,
      otherBytes: 1_480_000_000,
      freelistBytes: 0,
      pageSize: 4096,
      autoVacuum: 0,
    },
    months: [
      {
        month: '2026-05',
        rows: 225_244,
        contentBytes: 1_128_000_000,
        endedRows: 208_267,
        eligible: true,
        archived: false,
      },
      {
        month: '2026-06',
        rows: 565_792,
        contentBytes: 2_539_000_000,
        endedRows: 555_602,
        eligible: true,
        archived: false,
      },
      {
        month: '2026-08',
        rows: 140_923,
        contentBytes: 779_000_000,
        endedRows: 101_461,
        eligible: false,
        archived: false,
      },
    ],
    orphans: {
      rows: 50_329,
      contentBytes: 112_000_000,
      conversations: 242,
      months: ['2026-04', '2026-05'],
      sweepableMonths: [],
      sweepableRows: 0,
      sweepableBytes: 0,
    },
    redundantIndexes: [],
    fileSweeps: [],
    projectedTranscriptBytes: 5_700_000_000,
    projectedTotalBytes: 5_700_000_000,
    projectedDbBytesAfter: 4_300_000_000,
    vacuum: {
      freeBytes: 319_000_000_000,
      neededBytes: 10_000_000_000,
      hasHeadroom: true,
      estimatedLockSeconds: 62,
      willEnableIncremental: true,
    },
    ...overrides,
  }
}

/** jest-dom matchers are not installed here, so assert on the DOM property. */
function vacuumButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^vacuum$/i }) as HTMLButtonElement
}

function checkbox(name: RegExp): HTMLInputElement {
  return screen.getByRole('checkbox', { name }) as HTMLInputElement
}

function footer(est: VacuumEstimate) {
  return render(
    <VacuumFooter
      estimate={est}
      busy={false}
      measuringBytes={false}
      onMeasureBytes={vi.fn()}
      onPlan={vi.fn()}
      onApply={vi.fn()}
    />,
  )
}

describe('bytes are never faked', () => {
  test('an unmeasured figure renders as a placeholder, not 0 B', () => {
    expect(formatMeasuredBytes(0, UNMEASURED)).toBe('--')
    expect(formatMeasuredBytes(5_700_000_000, UNMEASURED)).toBe('--')
    expect(formatMeasuredBytes(5_700_000_000, MEASURED)).toBe('5.3 GB')
  })

  test('a genuinely empty measured category still reads 0 B', () => {
    expect(formatMeasuredBytes(0, MEASURED)).toBe('0 B')
    expect(formatBytes(0)).toBe('0 B')
  })

  test('the age line distinguishes never-measured from just-measured', () => {
    expect(describeBytes(UNMEASURED)).toContain('not measured yet')
    expect(describeBytes(MEASURED)).toContain('just now')
    expect(describeBytes({ ...MEASURED, provenance: 'cached', ageSeconds: 7200 })).toContain('2 hours ago')
  })
})

describe('the backup gate is visible and blocking', () => {
  test('a passing gate leaves the vacuum button enabled', () => {
    footer(estimate())
    expect(vacuumButton().disabled).toBe(false)
  })

  test('a failing gate disables it and shows the literal reason', () => {
    footer(
      estimate({
        gate: {
          ok: false,
          reason: 'last successful backup is 600m old (max 90m)',
          backupArchive: '',
          backupAgeMinutes: 600,
        },
      }),
    )
    expect(vacuumButton().disabled).toBe(true)
    expect(screen.getByText(/600m old/)).toBeTruthy()
  })

  test('the VACUUM stall is stated up front, not discovered', () => {
    footer(estimate())
    expect(screen.getByText(/stops answering for roughly/i)).toBeTruthy()
    expect(screen.getByText(/1m 2s/)).toBeTruthy()
  })

  test('insufficient disk headroom is called out', () => {
    footer(estimate({ vacuum: { ...estimate().vacuum, hasHeadroom: false, freeBytes: 1_000_000 } }))
    expect(screen.getByText(/Not enough free disk/i)).toBeTruthy()
  })
})

describe('rows', () => {
  test('the transcript row names the months and says conversations survive', () => {
    render(<VacuumRows estimate={estimate()} selection={DEFAULT_SELECTION} onChange={vi.fn()} />)
    expect(screen.getByText(/2026-05, 2026-06/)).toBeTruthy()
    expect(screen.getByText(/archive import/)).toBeTruthy()
  })

  test('orphans are informational and cannot be ticked', () => {
    render(<VacuumRows estimate={estimate()} selection={DEFAULT_SELECTION} onChange={vi.fn()} />)
    expect(checkbox(/orphaned transcript rows/i).disabled).toBe(true)
    expect(screen.getByText(/reclaimed by it -- no separate delete/i)).toBeTruthy()
  })

  test('the transcript row is disabled when no month has aged out', () => {
    const est = estimate({ months: estimate().months.map(m => ({ ...m, eligible: false })) })
    render(<VacuumRows estimate={est} selection={DEFAULT_SELECTION} onChange={vi.fn()} />)
    expect(checkbox(/transcript history/i).disabled).toBe(true)
    expect(screen.getByText(/none qualify/i)).toBeTruthy()
  })

  test('changing the age threshold reports the new hotDays', () => {
    const onChange = vi.fn()
    render(<VacuumRows estimate={estimate()} selection={DEFAULT_SELECTION} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/age threshold/i), { target: { value: '60' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hotDays: 60 }))
  })
})

describe('the apply confirm', () => {
  test('names the exact months and row count, not just a total', () => {
    render(
      <ApplyConfirm open estimate={estimate()} selection={DEFAULT_SELECTION} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    )
    expect(screen.getByText(/2026-05, 2026-06/)).toBeTruthy()
    expect(screen.getByText(/791,036 rows/)).toBeTruthy()
  })

  test('only fires on the explicit destructive button', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ApplyConfirm
        open
        estimate={estimate()}
        selection={DEFAULT_SELECTION}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /delete and reclaim/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
