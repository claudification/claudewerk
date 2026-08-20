/**
 * THE CROSS-PANE REWIND PROOF -- one scrubber, the whole grid, pane by pane.
 *
 * The filter's cross-pane suite proves thirteen independently-written wirings
 * AGREE about a query. This is the same claim for the time cursor, and it needs
 * its own suite for a reason the W1 card names: the delivery check for W1 used
 * to be one grep for a symbol, so "every pane obeys" could be true of a store
 * nobody read. The only honest proof is to mount the REAL surface over a
 * data-bearing fixture, drag the cursor, and read the answer off every pane.
 *
 * THE THREE ANSWERS A PANE MAY GIVE, and every pane gives exactly one:
 *
 *   NARROWED -- it declares the `time` axis, so its rows carry a clock and
 *               `useWallFilter` has dropped the ones that had not happened yet.
 *   SERIES   -- no rows to drop, but a real history: S1's cpu ring, S2's plan
 *               samples. It looks the value up at the offset itself.
 *   BLIND    -- no history at all, so it says "no history at this offset"
 *               instead of showing live numbers under a rewound header.
 *
 * THIS SUITE WRITES NO PRODUCTION CODE beyond the card's own. A pane that fails
 * here has a bug in its own file and its own card.
 *
 * THE CLOCK IS FAKED, and it has to be: the fixture's rows are dated against a
 * fixed `NOW`, and an age measured from the real clock would be years, which
 * makes every row older than every offset and the whole rewind a no-op that
 * passes. `shouldAdvanceTime` keeps the lazy pane imports resolving.
 */

import { act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWallCursorStore, WALL_CURSOR_SPAN_MS, WALL_CURSOR_STEP_MS } from '@/lib/wall/cursor-store'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { activeRuns, NOW, pinsFor, seedTheWall } from './wall-crosspane-feed'
import { WALL_PANE_CODES } from './wall-pane-registry'
import { installWallTestHooks, openTheWall, pane, wallRoot } from './wall-test-utils'

vi.mock('@/hooks/project-task-wire', () => ({
  sendBoardOp: vi.fn(async (projectUri: string) => ({ pinned: pinsFor(projectUri) })),
  installProjectHandler: vi.fn(),
}))
vi.mock('@/lib/epic-inspect-api', () => ({
  fetchActiveRuns: vi.fn(async () => ({ ok: true, data: activeRuns() })),
  inspectRun: vi.fn(async () => ({ ok: true, data: null })),
}))

installWallTestHooks()

const MINUTE = WALL_CURSOR_STEP_MS

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  useWallFilterStore.getState().clear()
  useWallCursorStore.getState().release()
  seedTheWall()
})

afterEach(() => {
  useWallCursorStore.getState().release()
  vi.useRealTimers()
})

/** Drag the shared scrubber, the way a hand does. */
function rewindTo(offsetMs: number): void {
  act(() => {
    useWallCursorStore.getState().setOffsetMs(offsetMs)
  })
}

/** A pane's own `{matched}/{total}`, read off the surface -- the same slot the
 *  filter proof reads, so a pane cannot satisfy one suite and not the other. */
function paneCount(code: string): { matched: number; total: number } | null {
  const el = pane(code)
  const slot = code === 'A5' ? el?.querySelector('.wall-nowtotal') : el?.querySelector('.wall-pane-count')
  const hit = /(\d+)\/(\d+)/.exec(slot?.textContent ?? '')
  return hit ? { matched: Number(hit[1]), total: Number(hit[2]) } : null
}

/**
 * Panes the shared chrome has VEILED -- ones that declared no way to be rewound
 * and therefore have nothing true to show at this offset.
 *
 * Read off `data-blind` rather than off the sentence, and the distinction is the
 * point: S1 and S2 print the very same words when their own series does not
 * reach the cursor, which is a pane answering the cursor, not a pane that cannot.
 * Matching on text would call those two blind and hide the fact that they are
 * doing the work.
 */
function blindPanes(): string[] {
  return WALL_PANE_CODES.filter(code => pane(code)?.dataset.blind === 'true')
}

async function openTheFullWall(): Promise<void> {
  await openTheWall()
  await waitFor(() => {
    for (const code of WALL_PANE_CODES) expect(`${code}:${paneCount(code)?.total}`).not.toMatch(/:(undefined|0)$/)
  })
}

/**
 * WHAT EACH PANE IS, and it is derived from the pane's own `AXES` declaration
 * rather than chosen here: a pane declares `time` exactly when its rows carry a
 * clock, and that is the same fact `useWallFilter` narrows on. S1 and S2 are the
 * two carve-outs, and both are stated on their own cards.
 */
const NARROWED = ['P1', 'P2', 'P3', 'A1', 'A5']
const SERIES = ['S1', 'S2']
const BLIND = WALL_PANE_CODES.filter(code => !NARROWED.includes(code) && !SERIES.includes(code))

describe('one store, and every pane obeys it', () => {
  it('leaves the whole grid alone at LIVE', async () => {
    await openTheFullWall()

    expect(blindPanes()).toEqual([])
    expect(wallRoot().dataset.rewound).toBeUndefined()
  })

  it('narrows the panes with a clock and BLINDS the ones without, in one drag', async () => {
    await openTheFullWall()
    const before = WALL_PANE_CODES.map(code => `${code}=${paneCount(code)?.total}`)

    rewindTo(3 * MINUTE)

    // Every pane with no history says so, and NOT ONE of them still prints a
    // count -- a `12/12` beside "no history at this offset" is the pane
    // contradicting itself on screen.
    expect(blindPanes()).toEqual(BLIND)
    for (const code of BLIND) expect(`${code}:${paneCount(code)}`).toBe(`${code}:null`)

    // ...and the panes that DO have a clock moved, rather than being left as they
    // were. Without this the line above would pass on a wall where the cursor
    // only ever greys things out.
    const after = WALL_PANE_CODES.map(code => `${code}=${paneCount(code)?.total}`)
    expect(after).not.toEqual(before)
  })

  it('gives each narrowed pane its OWN answer -- never one shared verdict', async () => {
    await openTheFullWall()

    // The fixture's clocks: conversations last spoke 1m ago, permissions have
    // been waiting 2m, card moves landed 2m and 4m ago, commits 5m ago. So each
    // offset below cuts a DIFFERENT set of panes, which is the whole claim: one
    // store, thirteen independent readings of it.
    rewindTo(3 * MINUTE)
    expect(paneCount('P1')?.total).toBe(0) // last turn 1m ago -- not yet, at T-3m
    expect(paneCount('A5')?.total).toBe(0)
    expect(paneCount('A1')?.total).toBe(0) // waiting 2m -- was not blocked yet
    expect(paneCount('P3')?.total).toBe(1) // the 4m move, not the 2m one
    expect(paneCount('P2')?.total).toBe(2) // both commits are 5m old

    rewindTo(6 * MINUTE)
    expect(paneCount('P2')?.total).toBe(0) // now the river is empty too
    expect(paneCount('P3')?.total).toBe(0)
  })

  it('reads a row that is EXACTLY as old as the cursor as already there', async () => {
    await openTheFullWall()

    // The 4m card move at T-4m. Off by one here and a row blinks out for a
    // minute of scrubbing and back in for the next.
    rewindTo(4 * MINUTE)
    expect(paneCount('P3')?.total).toBe(1)
    rewindTo(4 * MINUTE + MINUTE)
    expect(paneCount('P3')?.total).toBe(0)
  })

  it('lets the two SERIES panes answer for themselves instead of blinding them', async () => {
    await openTheFullWall()
    rewindTo(MINUTE)

    // Neither declares `~time` -- their rows have no per-row clock -- so if the
    // cursor were only wired through `useWallFilter` both would be blind here.
    for (const code of SERIES) expect(`${code}:${blindPanes().includes(code)}`).toBe(`${code}:false`)

    // S1's ring is one sample long in the fixture, so a minute back is past the
    // end of it: the node is DROPPED and the pane says why, rather than showing
    // a five-second-old cpu number under a `T-1m` header.
    expect(paneCount('S1')?.total).toBe(0)
    expect(pane('S1')?.textContent).toMatch(/no history at this offset/)

    // S2's samples are all at NOW, so a minute back is before every one of them.
    expect(paneCount('S2')?.total).toBe(0)
    expect(pane('S2')?.textContent).toMatch(/no history at this offset/)
    // ...and specifically NOT the stub's "no feed yet", which would say the
    // broker never spoke.
    expect(pane('S2')?.textContent).not.toMatch(/no feed yet/)
  })

  it('SNAPS FORWARD: releasing to LIVE restores every pane exactly', async () => {
    await openTheFullWall()
    const live = WALL_PANE_CODES.map(code => `${code}=${paneCount(code)?.matched}/${paneCount(code)?.total}`)

    rewindTo(42 * MINUTE)
    expect(blindPanes().length).toBeGreaterThan(0)

    act(() => {
      useWallCursorStore.getState().release()
    })

    expect(blindPanes()).toEqual([])
    // Not "roughly the same" -- the SAME. A duplicated row or a dropped one
    // shows up here as a changed count on the pane that lost it.
    expect(WALL_PANE_CODES.map(code => `${code}=${paneCount(code)?.matched}/${paneCount(code)?.total}`)).toEqual(live)
  })

  it('composes with the filter rather than replacing it', async () => {
    await openTheFullWall()
    rewindTo(3 * MINUTE)

    // Both constraints at once, on the one pane that still has rows at T-3m.
    // `matched` is the query's answer, `total` is the cursor's -- a pane that
    // counted against the LIVE row set would print `0/2` here and read as a
    // filter that took everything.
    act(() => {
      useWallFilterStore.getState().setRaw('@anvil-md')
    })
    expect(paneCount('P3')).toEqual({ matched: 1, total: 1 })

    act(() => {
      useWallFilterStore.getState().setRaw('@remote-claude')
    })
    expect(paneCount('P3')).toEqual({ matched: 0, total: 1 })
  })
})

describe('a rewound wall can never be read as live', () => {
  it('marks the surface, the dot and the header, all from the one store', async () => {
    await openTheFullWall()
    rewindTo(42 * MINUTE)

    // The grid's desaturation hangs off this attribute -- one element, so the
    // wall cannot grey twelve panes and forget the thirteenth.
    expect(wallRoot().dataset.rewound).toBe('true')
    // The dot is the thing a room reads from four metres away.
    expect(wallRoot().querySelector('.wall-livedot')?.getAttribute('data-rewound')).toBe('true')
    // In ambient mode the scrubber is hidden, so the brand carries the offset.
    expect(wallRoot().querySelector('.wall-rewound-mark')?.textContent).toBe('T-42m')
    expect(wallRoot().querySelector('.wall-scrub-value')?.textContent).toBe('T-42m')
  })

  it('says LIVE, and nothing else, when it is', async () => {
    await openTheFullWall()

    expect(wallRoot().querySelector('.wall-scrub-value')?.textContent).toBe('LIVE')
    expect(wallRoot().querySelector('.wall-rewound-mark')).toBeNull()
    expect(wallRoot().querySelector('.wall-livedot')?.getAttribute('data-rewound')).toBeNull()
  })
})

describe('the scrubber is a timeline: past LEFT, LIVE RIGHT', () => {
  function track(): HTMLInputElement {
    return wallRoot().querySelector('.wall-scrub input') as HTMLInputElement
  }

  it('parks at the RIGHT end when live, and moves LEFT as the offset grows', async () => {
    await openTheFullWall()
    const max = Number(track().max)

    expect(max).toBe(WALL_CURSOR_SPAN_MS / WALL_CURSOR_STEP_MS)
    expect(Number(track().value)).toBe(max)

    rewindTo(42 * MINUTE)
    expect(Number(track().value)).toBe(max - 42)

    // The far left is the far past -- the mockup had this backwards once and it
    // read wrong the instant anybody touched it.
    rewindTo(WALL_CURSOR_SPAN_MS)
    expect(Number(track().value)).toBe(0)
  })

  it('rewinds the wall when dragged left', async () => {
    await openTheFullWall()
    fireEvent.change(track(), { target: { value: String(Number(track().max) - 5) } })

    expect(useWallCursorStore.getState().offsetMs).toBe(5 * MINUTE)
    expect(wallRoot().dataset.rewound).toBe('true')
  })

  it('is focused by T, and stepped by the arrows -- left into the past', async () => {
    await openTheFullWall()

    fireEvent.keyDown(document, { key: 'T' })
    expect(document.activeElement).toBe(track())

    fireEvent.keyDown(track(), { key: 'ArrowLeft' })
    fireEvent.keyDown(track(), { key: 'ArrowLeft' })
    expect(useWallCursorStore.getState().offsetMs).toBe(2 * MINUTE)

    fireEvent.keyDown(track(), { key: 'ArrowRight' })
    expect(useWallCursorStore.getState().offsetMs).toBe(MINUTE)

    // And it cannot be pushed past LIVE into the future.
    fireEvent.keyDown(track(), { key: 'ArrowRight' })
    fireEvent.keyDown(track(), { key: 'ArrowRight' })
    expect(useWallCursorStore.getState().offsetMs).toBe(0)
  })

  it('does not steal a T that was typed into the filter box', async () => {
    await openTheFullWall()
    const box = wallRoot().querySelector('.wall-filter input') as HTMLInputElement
    box.focus()

    fireEvent.keyDown(box, { key: 't' })
    expect(document.activeElement).toBe(box)
  })

  it('offers the way back only while there is one', async () => {
    await openTheFullWall()
    expect(wallRoot().querySelector('.wall-scrub-live')).toBeNull()

    rewindTo(10 * MINUTE)
    fireEvent.click(wallRoot().querySelector('.wall-scrub-live') as Element)

    expect(useWallCursorStore.getState().offsetMs).toBe(0)
    expect(wallRoot().dataset.rewound).toBeUndefined()
  })
})
