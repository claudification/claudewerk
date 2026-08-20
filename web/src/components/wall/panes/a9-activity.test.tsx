/**
 * A9: the six claims the card makes about the activity matrix.
 *
 *  - THREE CELL STATES, not two. `unavailable` is visibly not `empty`, and
 *    switching from `commits` to a 30-day metric makes the old months go NO
 *    DATA rather than go idle. This is the claim the whole card is about.
 *  - the switch defaults to `commits` -- an OUTPUT metric -- and changes the
 *    colour scale rather than the geometry.
 *  - a USD day declares exact-vs-estimated. An inferred number is never
 *    rendered as a measured one.
 *  - hover shows EVERY metric's number for that day, off one request.
 *  - a click scopes the whole wall to that day, and a second click clears it.
 *  - the request carries the VIEWER's zone. The broker is UTC and would bucket
 *    a Thai evening onto the wrong square if it were left to guess.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { resetWallRevive } from '@/lib/wall/revive-store'
import { activityMatrixFixture } from '../activity-fixture'
import ActivityPane from './a9-activity'

/** The fixture's axis, dated against a FIXED instant so the day strings a test
 *  asserts on cannot drift with the wall clock. */
const NOW = Date.UTC(2026, 7, 21, 12, 0)
const MATRIX = activityMatrixFixture(NOW)

let requested: string[] = []

function stubFeed(body: unknown = MATRIX, ok = true) {
  requested = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(String(url))
      return { ok, status: ok ? 200 : 403, json: async () => body }
    }),
  )
}

async function mount(body: unknown = MATRIX, ok = true) {
  stubFeed(body, ok)
  const view = render(<ActivityPane />)
  await waitFor(() => expect(requested.length).toBeGreaterThan(0))
  return view
}

/** Every square, in axis order. */
const squares = () => [...document.querySelectorAll<HTMLElement>('.wall-activity-cell[data-day]')]
const statesOf = () => squares().map(el => el.dataset.state)
const squareFor = (day: string) => document.querySelector<HTMLElement>(`.wall-activity-cell[data-day="${day}"]`)

/** Switch the grid to another metric, the way a hand does. */
function pick(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label.toUpperCase() }))
}

beforeEach(() => {
  resetWallRevive()
  useWallFilterStore.getState().clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the three cell states', () => {
  it('renders all three, and never collapses two of them into one', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))

    const states = new Set(statesOf())
    // `commits` reaches the whole fixture axis, so it has active and empty but
    // no unavailable -- which is exactly why the metric switch is the test below.
    expect(states).toContain('active')
    expect(states).toContain('empty')
  })

  it('THE CLAIM: switching to a 30-day metric goes NO DATA, not idle', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))

    const commits = statesOf()
    expect(commits.filter(s => s === 'unavailable')).toHaveLength(0)

    pick('Turns')
    const turns = statesOf()

    // The same calendar days. Under `turns` the old ones are UNAVAILABLE...
    expect(turns.filter(s => s === 'unavailable').length).toBeGreaterThan(20)
    // ...and specifically NOT `empty`, which would say we measured a quiet day.
    expect(turns.slice(0, 20).every(s => s === 'unavailable')).toBe(true)
    expect(commits.slice(0, 20).some(s => s !== 'unavailable')).toBe(true)
  })

  it('gives an unavailable square no colour level at all', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))
    pick('Turns')

    // A level class IS a colour. On a day nobody has data for there is nothing
    // to colour, so a `lvl-*` here would be the grid inventing a reading.
    const grey = squares().filter(el => el.dataset.state === 'unavailable')
    expect(grey.length).toBeGreaterThan(0)
    expect(grey.some(el => /lvl-\d/.test(el.className))).toBe(false)
  })

  it('spells both silences out in the legend, so a grey run can be read', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))
    const legend = () => document.querySelector('.wall-activity-legend')?.textContent ?? ''
    expect(legend()).toMatch(/NONE/)
    expect(legend()).toMatch(/NO DATA/)
    // The horizon line belongs to the SELECTED metric, so it changes with the
    // switch -- and on a pruned one it says why the grey is grey.
    expect(legend()).toMatch(/recorded since/)
    pick('Turns')
    expect(legend()).toMatch(/30d retention -- older days are NOT ZERO/)
  })
})

describe('the metric switch', () => {
  it('starts on COMMITS -- the output metric, never a volume one', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))
    // Turns and tokens go UP when an agent thrashes. A grid that opened on one
    // would paint the worst loop of the year as its best day.
    expect(screen.getByRole('button', { name: 'COMMITS' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'TOKENS' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('offers all five, output metrics first', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))
    const labels = [...document.querySelectorAll('.wall-activity-switch button')].map(b => b.textContent)
    expect(labels).toEqual(['COMMITS', 'CARDS CLOSED', 'TURNS', 'TOKENS', 'USD'])
  })

  it('changes the scale, not the geometry -- the same days are on screen', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))
    const before = squares().map(el => el.dataset.day)
    pick('USD')
    expect(squares().map(el => el.dataset.day)).toEqual(before)
  })
})

describe('an estimated dollar is never rendered as a measured one', () => {
  it('carries the split onto the hovered day', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))

    // The fixture's USD days are half measured and half priced from tokens,
    // which is the mixed case production actually produces.
    const usdDay = MATRIX.days[MATRIX.days.length - 2].day
    fireEvent.mouseEnter(squareFor(usdDay) as Element)

    const fact = document.querySelector('.wall-activity-fact[data-metric="usd"]')
    expect(fact?.textContent).toMatch(/ESTIMATED/)
    expect(fact?.querySelector('.wall-activity-provenance')).toBeTruthy()
  })
})

describe('hover and click', () => {
  it('shows EVERY metric for the hovered day, off the one request', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))
    expect(requested).toHaveLength(1)

    fireEvent.mouseEnter(squares()[squares().length - 1] as Element)
    const metrics = [...document.querySelectorAll('.wall-activity-fact')].map(el => el.getAttribute('data-metric'))
    expect(metrics).toEqual(['commits', 'cardsClosed', 'turns', 'tokens', 'usd'])
    // Still one request: the hover is an index lookup into the shared axis.
    expect(requested).toHaveLength(1)
  })

  it('tells the two silences apart in the hover card as well as in the grid', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))

    // Day 0 is inside the commit ledger's coverage and outside the 30-day floor.
    fireEvent.mouseEnter(squareFor(MATRIX.days[1].day) as Element)
    const read = (metric: string) =>
      document.querySelector(`.wall-activity-fact[data-metric="${metric}"] dd`)?.textContent
    expect(read('commits')).toBe('none')
    expect(read('turns')).toBe('no data')
  })

  it('scopes the WHOLE WALL to that day, and a second click clears it', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))
    const day = MATRIX.days[MATRIX.days.length - 1].day

    fireEvent.click(squareFor(day) as Element)
    // The token a human would have typed, in the shared box -- not a private
    // selection this pane keeps to itself.
    expect(useWallFilterStore.getState().raw).toBe(`~${day}`)
    expect(useWallFilterStore.getState().query.day).toBe(day)
    expect(squareFor(day)?.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(squareFor(day) as Element)
    expect(useWallFilterStore.getState().raw).toBe('')
  })

  it('narrows its OWN grid on free text over the date', async () => {
    await mount()
    await waitFor(() => expect(squares().length).toBeGreaterThan(0))
    const month = MATRIX.days[MATRIX.days.length - 1].day.slice(0, 7)

    useWallFilterStore.getState().setRaw(month)
    await waitFor(() => expect(squares().every(el => el.dataset.day?.startsWith(month))).toBe(true))

    useWallFilterStore.getState().setRaw('zzzznothingmatchesthis')
    await waitFor(() => expect(screen.getByText(/no day matches the filter/)).toBeTruthy())
  })
})

describe('the request', () => {
  it("sends the VIEWER's zone rather than letting a UTC broker guess", async () => {
    await mount()
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    expect(requested[0]).toContain(`tz=${encodeURIComponent(zone)}`)
    expect(requested[0]).toContain('days=366')
  })

  it('says the route is admin-only rather than drawing an empty year', async () => {
    // A 403 body is not a matrix. Rendered as one it would be 366 squares of
    // nothing, which reads as a year off instead of as a permission answer.
    await mount({ error: 'Forbidden: admin only' }, false)
    await waitFor(() => expect(screen.getByText(/admin-only/)).toBeTruthy())
    expect(squares()).toHaveLength(0)
  })

  it('refuses a body that is not a matrix, however plausible', async () => {
    await mount([])
    await waitFor(() => expect(screen.getByText(/admin-only/)).toBeTruthy())
  })
})
