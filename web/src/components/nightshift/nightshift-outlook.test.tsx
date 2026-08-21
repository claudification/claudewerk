/**
 * THE REGRESSION THIS PANE EXISTS TO STOP: it used to render `queue_list`, the
 * store the night run stopped reading when the input moved to the `#nightshift`
 * tag -- so it confidently listed entries that would never run and hid the cards
 * that would.
 *
 * These tests pin the two halves of the fix: tonight's list is the SCAN's
 * answer, and the legacy queue is visible only as clearly-labelled leftovers,
 * never as tonight's list.
 */

import type { NightshiftQueueItem } from '@shared/nightshift-types'
import type { NightshiftOutlook as OutlookData } from '@shared/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const useNightshiftOutlook = vi.fn()
const useNightshiftQueue = vi.fn()

vi.mock('@/hooks/use-nightshift-outlook', () => ({
  useNightshiftOutlook: (...args: unknown[]) => useNightshiftOutlook(...args),
}))
vi.mock('@/hooks/use-nightshift-queue', () => ({
  useNightshiftQueue: (...args: unknown[]) => useNightshiftQueue(...args),
  dequeueNightshiftTask: vi.fn(),
  runNightshiftNow: vi.fn(),
}))
vi.mock('./assign-tasks-dialog', () => ({ AssignTasksDialog: () => null }))

import { NightshiftOutlook } from './nightshift-outlook'

const URI = 'claude://default/p'
const BUCKETS = ['closed-lane', 'live-conversation', 'unreadable', 'over-cap']

function task(id: string, title: string, boardRef: string): NightshiftQueueItem {
  return {
    id,
    title,
    project: URI,
    status: 'queued',
    source: 'board',
    boardRef,
    created: '2026-08-21T22:00:00Z',
    body: `body of ${boardRef}`,
  }
}

function leftover(id: string, title: string): NightshiftQueueItem {
  return { id, title, project: URI, status: 'queued', source: 'manual', created: '2026-06-01T00:00:00Z', body: '' }
}

function setup(outlook: Partial<OutlookData> | null, queue: NightshiftQueueItem[] = [], error: string | null = null) {
  useNightshiftOutlook.mockReturnValue({
    outlook: outlook
      ? { admitted: [], refused: [], selected: [], buckets: BUCKETS, totalTasks: 8, ...outlook }
      : undefined,
    loading: false,
    error,
    refetch: vi.fn(),
  })
  useNightshiftQueue.mockReturnValue({ queue, loading: false, error: null, refetch: vi.fn() })
  render(<NightshiftOutlook projectUri={URI} />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("tonight's list is the scan's answer", () => {
  test('renders the cards the scan admitted', () => {
    setup({ admitted: [task('001', 'rewrite the boot payload', 'boot-payload')], selected: ['boot-payload'] })
    expect(screen.getByText('rewrite the boot payload')).toBeDefined()
    expect(screen.getByText('boot-payload')).toBeDefined()
  })

  test("a legacy queue entry is NEVER in tonight's list -- it is a labelled leftover", () => {
    setup({ admitted: [], selected: [] }, [leftover('001', 'filed before the switch')])
    expect(screen.queryByText('filed before the switch')).toBeNull()
    expect(screen.getByText(/1 leftover entry in the retired queue/)).toBeDefined()
  })

  test('the leftovers expand on demand, and removing one is still possible', () => {
    setup({ admitted: [], selected: [] }, [leftover('001', 'filed before the switch')])
    fireEvent.click(screen.getByText(/1 leftover entry in the retired queue/))
    expect(screen.getByText('filed before the switch')).toBeDefined()
    expect(screen.getByTitle('Remove from the nightshift queue')).toBeDefined()
  })

  test('Run-now follows the SCAN, not the dead queue: leftovers alone leave it disabled', () => {
    setup({ admitted: [], selected: [] }, [leftover('001', 'filed before the switch')])
    const run = screen.getByRole('button', { name: /Run nightshift now/ }) as HTMLButtonElement
    expect(run.disabled).toBe(true)
  })
})

describe('the refusals are on screen', () => {
  test('summarises what will run and what will not, bucket by bucket', () => {
    setup({
      admitted: [task('001', 'a card', 'a')],
      refused: [
        { unit: 'b', bucket: 'live-conversation', detail: 'a live conversation is on this card' },
        { unit: 'c', bucket: 'over-cap', detail: 'run opens with at most 1 task(s)' },
      ],
      selected: ['a', 'b', 'c'],
      totalTasks: 1,
    })
    expect(screen.getByText(/1 of 3 tagged, 1 held by a live conversation, 1 over the cap/)).toBeDefined()
    expect(screen.getByText('b')).toBeDefined()
    expect(screen.getByText('a live conversation is on this card')).toBeDefined()
    expect(screen.getByText(/the run opens with at most 1/)).toBeDefined()
  })

  test('tagged but nothing runnable says so, instead of showing an empty list', () => {
    setup({
      admitted: [],
      refused: [{ unit: 'a', bucket: 'closed-lane', detail: 'card is in `done`' }],
      selected: ['a'],
      idleReason: '1 card(s) tagged #nightshift, none of them runnable',
    })
    expect(screen.getByText('1 card(s) tagged #nightshift, none of them runnable')).toBeDefined()
  })
})

describe('a failed scan is never an empty pane', () => {
  test('a crashed scan says so and offers a retry', () => {
    setup({ crashed: 'no sentinel connected for project' })
    expect(screen.getByText(/Board scan failed: no sentinel connected for project/)).toBeDefined()
    expect(screen.getByText('retry')).toBeDefined()
  })

  test('an RPC error says so too', () => {
    setup(null, [], 'nightshift request timed out')
    expect(screen.getByText(/Board scan failed: nightshift request timed out/)).toBeDefined()
  })

  test('nothing tagged is an honest empty state', () => {
    setup({ selected: [], idleReason: 'no cards tagged #nightshift' })
    expect(screen.getByText('no cards tagged #nightshift')).toBeDefined()
  })
})
