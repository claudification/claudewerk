/**
 * THE CONTROL BAR'S TWO DESTRUCTIVE VERBS, and the axis they share.
 *
 * ABORT is enabled only while the run is LIVE; DELETE only once it is not. That
 * complement is the whole design: they are the two ends of one axis rather than
 * two overlapping ways to end a run, and both are DISABLED rather than hidden so
 * a human learns the verb exists before they need it.
 *
 * The other property pinned here is the confirm. `delete` is the one verb on
 * this bar whose name lies about its blast radius unless the confirm says
 * otherwise: the artifact MOVES, and the epic's CARDS are untouched.
 */

import type { EpicRunSnapshot } from '@shared/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ del: vi.fn(async () => ({ ok: true as const, data: 'deleted, cards kept' })) }))
vi.mock('@/lib/epic-inspect-api', () => ({
  beatRun: vi.fn(),
  breakLease: vi.fn(),
  deleteEpicRun: api.del,
}))
vi.mock('@/lib/epic-run-api', () => ({
  abortEpicRun: vi.fn(),
  pauseEpicRun: vi.fn(),
  startEpicRun: vi.fn(),
}))

import { OverseerControls } from './overseer-controls'

const PROJECT = 'claude://default/p'

function run(status: EpicRunSnapshot['status']): EpicRunSnapshot {
  return { epicId: 'e1', project: PROJECT, status } as EpicRunSnapshot
}

function mount(snapshot: EpicRunSnapshot | null, onDone = () => {}) {
  render(<OverseerControls project={PROJECT} epicId="e1" run={snapshot} leaseHeld={false} onDone={onDone} />)
  return screen.getByRole('button', { name: /DELETE/ })
}

let confirmed: string[]

beforeEach(() => {
  api.del.mockClear()
  api.del.mockResolvedValue({ ok: true, data: 'deleted, cards kept' })
  confirmed = []
  vi.stubGlobal('confirm', (message: string) => {
    confirmed.push(message)
    return true
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('the overseer window can delete a run', () => {
  it('offers DELETE on an ended run', () => {
    expect(mount(run('aborted')).hasAttribute('disabled')).toBe(false)
  })

  /** THE COMPLEMENT OF ABORT'S GUARD. A live run is aborted, never deleted. */
  it.each(['armed', 'running'] as const)('refuses to delete a %s run, visibly', status => {
    const button = mount(run(status))
    expect(button.hasAttribute('disabled')).toBe(true)
    // Still RENDERED, so a human learns the verb exists.
    expect(button.textContent).toContain('DELETE')
  })

  it('an epic with no run has nothing to delete', () => {
    expect(mount(null).hasAttribute('disabled')).toBe(true)
  })

  it('confirms first, and the confirm names what survives', () => {
    fireEvent.click(mount(run('complete')))

    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]).toContain('.deleted/')
    expect(confirmed[0]).toContain('CARDS are NOT deleted')
  })

  it('a declined confirm sends nothing', () => {
    vi.stubGlobal('confirm', () => false)

    fireEvent.click(mount(run('aborted')))

    expect(api.del).not.toHaveBeenCalled()
  })

  /** The reply is passed through verbatim: it names the tombstone AND counts the
   *  cards it left alone, and summarising it here would throw both away. */
  it('shows the reply verbatim', async () => {
    fireEvent.click(mount(run('aborted')))

    expect(await screen.findByText('deleted, cards kept')).toBeTruthy()
  })
})
