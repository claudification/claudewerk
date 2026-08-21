/**
 * The surface, mounted, against a fake wire.
 *
 * FOUR CLAIMS THAT ARE WORTH BREAKING THE BUILD OVER:
 *
 *  1. OPENING IT TRIGGERS NO SWEEP. The only frame that leaves is `latest`.
 *  2. `note-delete-at` HAS NO CHECKBOX. Not disabled -- absent (F18).
 *  3. PARKING KEEPS THE TICKS. The dock parks the body offscreen still mounted,
 *     which is the entire "leave it, come back, press Execute" story.
 *  4. EXECUTE SENDS ONLY WHAT IS TICKED, and renders what came BACK rather than
 *     what it asked for.
 */

import { archiveCold, flagDuplicate, noteDeleteAt, promoteDelivered } from '@shared/board-sweep-proposals'
import type { BoardApplyOutcome, BoardReportRecord } from '@shared/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { MorningReportModal } from './morning-report-modal'
import { resetBoardReportRouting } from './morning-report-rpc'
import { openMorningReport } from './morning-report-state'

const PROJECT = 'claude://default/p'
const store = () => useModalManagerStore.getState()

function report(over: Partial<BoardReportRecord> = {}): BoardReportRecord {
  return {
    project: PROJECT,
    date: '2026-08-22',
    tz: 'Europe/Berlin',
    reportPath: '.rclaude/project/reports/2026-08-22.md',
    proposals: [
      promoteDelivered({ card: 'shipped', from: 'open', closes: ['abc1234'] }),
      archiveCold({ card: 'cold-one', created: '2026-01-01T00:00:00Z', ageDays: 233 }),
      flagDuplicate({ card: 'twin-a', other: 'twin-b', confidence: 0.8, reason: 'same title' }),
      noteDeleteAt({ card: 'doomed', deleteAt: '2026-01-01', elapsedDays: 233 }),
    ],
    snapshot: 'head:600:1',
    skipped: false,
    selected: 9,
    acted: 4,
    refused: 5,
    sweptAt: Date.parse('2026-08-22T04:00:00Z'),
    ...over,
  }
}

interface Wire {
  sent: Record<string, unknown>[]
  push: (msg: Record<string, unknown>) => void
}

/** A broker that answers `latest` with `latest`, and `execute` with `applied`. */
function installWire(opts: { latest?: BoardReportRecord | null; applied?: BoardApplyOutcome[] } = {}): Wire {
  const sent: Record<string, unknown>[] = []
  useConversationsStore.setState({
    sendWsMessage: (msg: Record<string, unknown>) => {
      sent.push(msg)
      if (msg.type !== 'board_report_request') return true
      const reply =
        msg.op === 'latest'
          ? { type: 'board_report_result', requestId: msg.requestId, ok: true, report: opts.latest ?? null }
          : { type: 'board_report_result', requestId: msg.requestId, ok: true, applied: opts.applied ?? [] }
      queueMicrotask(() => useConversationsStore.getState().boardReportHandler?.(reply))
      return true
    },
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
  return {
    sent,
    push: msg => useConversationsStore.getState().boardReportHandler?.(msg),
  }
}

const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
  resetBoardReportRouting()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('opening the surface reads the recorded brew and TRIGGERS NO SWEEP', async () => {
  const wire = installWire({ latest: report() })

  openMorningReport(PROJECT)
  render(<MorningReportModal />)
  await waitFor(() => expect(screen.getByText('2026-08-22')).toBeTruthy())

  // The property the epic rests on: a panel that computes on open can never
  // visibly fail. The only verb that left is a read.
  expect(wire.sent.map(m => m.op)).toEqual(['latest'])
  expect(wire.sent.some(m => m.op === 'sweep')).toBe(false)
})

test('proposals render grouped by kind, with the D6 defaults already applied', async () => {
  installWire({ latest: report() })
  openMorningReport(PROJECT)
  render(<MorningReportModal />)
  await waitFor(() => expect(screen.getByText('shipped')).toBeTruthy())

  expect(screen.getByText(/Delivered -- promote to done/)).toBeTruthy()
  expect(screen.getByText(/Cold in inbox -- archive/)).toBeTruthy()
  expect(screen.getByText(/Possible duplicates/)).toBeTruthy()

  // Facts arrive ticked; the opinion does not.
  expect(box('promote-delivered shipped').checked).toBe(true)
  expect(box('archive-cold cold-one').checked).toBe(true)
  expect(box('flag-duplicate twin-a').checked).toBe(false)
})

test('F18: a `note-delete-at` row is rendered and has NO CHECKBOX AT ALL', async () => {
  installWire({ latest: report() })
  openMorningReport(PROJECT)
  render(<MorningReportModal />)
  await waitFor(() => expect(screen.getByText('doomed')).toBeTruthy())

  // Seen, never executable. A disabled box would say "not right now"; absence
  // says what F18 actually means.
  expect(screen.queryByRole('checkbox', { name: 'note-delete-at doomed' })).toBeNull()
})

test('TICK ALL cannot arm the duplicate', async () => {
  installWire({ latest: report() })
  openMorningReport(PROJECT)
  render(<MorningReportModal />)
  await waitFor(() => expect(screen.getByText('twin-a')).toBeTruthy())

  fireEvent.click(screen.getByRole('button', { name: 'Untick all' }))
  expect(box('archive-cold cold-one').checked).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'Tick all' }))
  expect(box('archive-cold cold-one').checked).toBe(true)
  expect(box('promote-delivered shipped').checked).toBe(true)
  // The whole safety property, at the surface.
  expect(box('flag-duplicate twin-a').checked).toBe(false)
})

test('parking it in the dock and reopening PRESERVES the tick state', async () => {
  const wire = installWire({ latest: report() })
  openMorningReport(PROJECT)
  render(<MorningReportModal />)
  await waitFor(() => expect(screen.getByText('cold-one')).toBeTruthy())

  fireEvent.click(box('archive-cold cold-one'))
  fireEvent.click(box('flag-duplicate twin-a'))
  expect(box('archive-cold cold-one').checked).toBe(false)
  expect(box('flag-duplicate twin-a').checked).toBe(true)

  act(() => store().minimize('morning-report'))
  act(() => store().restore('morning-report'))

  // The body never remounted, so nothing was re-read and nothing was re-defaulted.
  expect(box('archive-cold cold-one').checked).toBe(false)
  expect(box('flag-duplicate twin-a').checked).toBe(true)
  expect(wire.sent.filter(m => m.op === 'latest')).toHaveLength(1)
})

test('Execute sends ONLY the ticked rows, and renders what came back', async () => {
  const wire = installWire({
    latest: report(),
    applied: [
      { kind: 'archive-cold', card: 'cold-one', ok: true, status: 'archived', archivedReason: 'cold' },
      { kind: 'promote-delivered', card: 'shipped', ok: false, error: 'no such card' },
    ],
  })
  openMorningReport(PROJECT)
  render(<MorningReportModal />)
  await waitFor(() => expect(screen.getByText('cold-one')).toBeTruthy())

  // Both facts are ticked by default; the duplicate and the marker are not.
  expect(screen.getByRole('button', { name: /Execute 2/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Execute 2/ }))

  await waitFor(() => expect(screen.getByText(/now `archived`/)).toBeTruthy())

  const executed = wire.sent.find(m => m.op === 'execute') as { execute: { proposals: unknown[]; date: string } }
  expect(executed.execute.date).toBe('2026-08-22')
  expect(executed.execute.proposals).toEqual([
    { kind: 'promote-delivered', card: 'shipped' },
    { kind: 'archive-cold', card: 'cold-one' },
  ])

  // A FAILED WRITE IS SHOWN AS A FAILURE. The row that did not land says so,
  // beside the one that did.
  expect(screen.getByText('no such card')).toBeTruthy()
})

test('no brew has ever arrived -> the surface says exactly that', async () => {
  installWire({ latest: null })
  openMorningReport(PROJECT)
  render(<MorningReportModal />)

  await waitFor(() => expect(screen.getByText(/No morning report has ever arrived/)).toBeTruthy())
  // The failure is named, with the reason it is probably happening. An empty
  // panel would be indistinguishable from a sweep broken for a month.
  expect(screen.getByText(/off by default for every project/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Execute/ })).toBeNull()
})

test('a report with no successor STAYS, labelled with its date', async () => {
  vi.setSystemTime(Date.parse('2026-08-25T06:00:00Z'))
  installWire({ latest: report({ date: '2026-08-22' }) })
  openMorningReport(PROJECT)
  render(<MorningReportModal />)

  await waitFor(() => expect(screen.getByText('2026-08-22')).toBeTruthy())
  // "From Saturday" is honest; an empty panel is ambiguous between "nothing
  // happened" and "the sweep is broken".
  expect(screen.getByText(/from Saturday/)).toBeTruthy()
  vi.useRealTimers()
})

test('a fresh brew pushed while PARKED replaces the rows and re-defaults the ticks', async () => {
  const wire = installWire({ latest: report() })
  openMorningReport(PROJECT)
  render(<MorningReportModal />)
  await waitFor(() => expect(screen.getByText('cold-one')).toBeTruthy())

  fireEvent.click(box('archive-cold cold-one'))
  act(() => store().minimize('morning-report'))

  // The schedule fires overnight. Nobody is looking at the panel.
  act(() => {
    wire.push({
      type: 'board_report_changed',
      project: PROJECT,
      report: report({
        date: '2026-08-23',
        proposals: [archiveCold({ card: 'fresh-one', created: '2026-01-02T00:00:00Z', ageDays: 234 })],
      }),
    })
  })

  act(() => store().restore('morning-report'))
  await waitFor(() => expect(screen.getByText('fresh-one')).toBeTruthy())
  // A tick means "I looked at this row", and the rows just changed.
  expect(box('archive-cold fresh-one').checked).toBe(true)
  expect(screen.queryByText('cold-one')).toBeNull()
})

test('a short-circuited sweep says NOTHING MOVED rather than rendering empty', async () => {
  installWire({
    latest: report({ skipped: true, proposals: [], acted: 0, idleReason: 'HEAD and the board are equal' }),
  })
  openMorningReport(PROJECT)
  render(<MorningReportModal />)

  await waitFor(() => expect(screen.getByText('Nothing moved.')).toBeTruthy())
  expect(screen.getByText(/HEAD and the board are equal/)).toBeTruthy()
  expect(screen.getByText(/cheap path, not a failure/)).toBeTruthy()
})
