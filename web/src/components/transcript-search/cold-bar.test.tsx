import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ArchivePlan, ArchiveSearchResponse } from './archive-api'
import { ColdBar } from './cold-bar'

vi.mock('@/lib/utils', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }
})

afterEach(cleanup)

const PLAN: ArchivePlan = {
  configured: true,
  months: [
    { month: '2026-04', rows: 33352, plaintextBytes: 102_700_000, compressedBytes: 14_100_000 },
    { month: '2026-03', rows: 1000, plaintextBytes: 5_000_000, compressedBytes: 700_000 },
  ],
  totalRows: 34352,
  totalPlaintextBytes: 107_700_000,
  totalCompressedBytes: 14_800_000,
  estimatedSeconds: 0.5,
  unmeasuredMonths: [],
}

function result(over: Partial<ArchiveSearchResponse> = {}): ArchiveSearchResponse {
  return {
    query: 'needle',
    regex: false,
    hits: [],
    scannedMonths: ['2026-04'],
    skippedMonths: [],
    rowsScanned: 33352,
    bytesScanned: 102_700_000,
    elapsedMs: 300,
    truncated: false,
    truncatedReason: '',
    ...over,
  }
}

const noop = () => {}
const base = {
  running: false,
  error: '',
  includeToolOutput: false,
  canRun: true,
  onRun: noop,
  onToggleToolOutput: noop,
}

test('nothing is offered when the broker has no cold archives', () => {
  const { container } = render(<ColdBar {...base} plan={null} result={null} />)
  expect(container.firstChild).toBeNull()
})

// The price has to be visible BEFORE the click. A button that silently starts a
// multi-minute scan is the failure this bar exists to prevent.
test('the cost is stated before the scan is run', () => {
  render(<ColdBar {...base} plan={PLAN} result={null} />)
  expect(screen.getByText(/2 archived months/)).toBeTruthy()
  expect(screen.getByText(/103 MB to scan/)).toBeTruthy()
  expect(screen.getByText(/about 0.5s/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'search cold archives' })).toBeTruthy()
})

test('an empty query cannot start a scan', () => {
  render(<ColdBar {...base} canRun={false} plan={PLAN} result={null} />)
  expect(screen.getByRole('button', { name: 'search cold archives' }).hasAttribute('disabled')).toBe(true)
})

test('coverage is reported after the scan', () => {
  render(<ColdBar {...base} plan={PLAN} result={result()} />)
  expect(screen.getByText(/scanned 2026-04/)).toBeTruthy()
  expect(screen.getByText(/33,352 rows/)).toBeTruthy()
  expect(screen.getByText(/in 0.3s/)).toBeTruthy()
})

// A truncated cold search that looks complete is worse than no search at all --
// the user concludes the thing they were looking for does not exist.
test('a truncated scan names what it never opened', () => {
  render(
    <ColdBar
      {...base}
      plan={PLAN}
      result={result({ truncated: true, truncatedReason: 'time', skippedMonths: ['2026-03'] })}
    />,
  )
  expect(screen.getByText(/INCOMPLETE/)).toBeTruthy()
  expect(screen.getByText(/ran out of time/)).toBeTruthy()
  expect(screen.getByText(/NOT searched: 2026-03/)).toBeTruthy()
})

test('a failure is shown rather than swallowed', () => {
  render(<ColdBar {...base} plan={PLAN} result={null} error="cold search failed: HTTP 403" />)
  expect(screen.getByText('cold search failed: HTTP 403')).toBeTruthy()
})
