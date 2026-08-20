/**
 * THE CROSS-PANE FILTER PROOF -- one query box, the whole grid, no blanking.
 *
 * Every pane wired its own `useWallFilter` call on its own branch, and each of
 * those cards proved its own pane in isolation against its own mocked feed. What
 * none of them could prove is that thirteen independently-written wirings AGREE
 * -- which is the only claim that matters to somebody reading the wall from
 * across a room: type one thing, and every surface either narrows the same way
 * or stays honestly full.
 *
 * So this suite mounts the REAL surface over a data-bearing fixture
 * (`wall-crosspane-feed.ts`) and asserts the epic's four contract lines across
 * every pane the registry declares.
 *
 * THIS SUITE WRITES NO PRODUCTION CODE. A pane that fails here has its own bug
 * and its own card; fixing eleven panes from here is the rewrite the filter-bus
 * split exists to prevent.
 */

import { act, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { ANVIL_NAME, activeRuns, pinsFor, RC_NAME, seedTheWall } from './wall-crosspane-feed'
import { WALL_PANE_CODES } from './wall-pane-registry'
import { installWallTestHooks, openTheWall, pane } from './wall-test-utils'

vi.mock('@/hooks/project-task-wire', () => ({
  sendBoardOp: vi.fn(async (projectUri: string) => ({ pinned: pinsFor(projectUri) })),
  installProjectHandler: vi.fn(),
}))
vi.mock('@/lib/epic-inspect-api', () => ({
  fetchActiveRuns: vi.fn(async () => ({ ok: true, data: activeRuns() })),
  inspectRun: vi.fn(async () => ({ ok: true, data: null })),
}))

installWallTestHooks()

beforeEach(() => {
  useWallFilterStore.getState().clear()
  seedTheWall()
})

interface PaneCount {
  matched: number
  total: number
}

/**
 * A pane's OWN `{matched}/{total}`, read off the surface.
 *
 * The head's count slot for the twelve grid panes; `.wall-nowtotal` for A5,
 * which is a strip with no pane head and puts the same pair in the mockup's
 * `of N` slot instead. Panes decorate the pair (`· 24h`, `waiting`, `· 5h`), so
 * the FIRST `n/m` in the slot is the contract and the rest is the pane's caption.
 */
function paneCount(code: string): PaneCount | null {
  const el = pane(code)
  const slot = code === 'A5' ? el?.querySelector('.wall-nowtotal') : el?.querySelector('.wall-pane-count')
  const hit = /(\d+)\/(\d+)/.exec(slot?.textContent ?? '')
  return hit ? { matched: Number(hit[1]), total: Number(hit[2]) } : null
}

/** `CODE=matched/total` for every pane, in registry order. Compared as STRINGS so
 *  a failure names the pane that broke instead of printing two number pairs. */
function census(): string[] {
  return WALL_PANE_CODES.map(code => {
    const c = paneCount(code)
    return c ? `${code}=${c.matched}/${c.total}` : `${code}=no count`
  })
}

/** Type into the shared box, the way a human does. */
function typeQuery(raw: string): void {
  act(() => {
    useWallFilterStore.getState().setRaw(raw)
  })
}

/** Mount, and wait until the HTTP-fed panes have landed their rows -- a filter
 *  proof against a grid that is still loading proves nothing. */
async function openTheFullWall(): Promise<void> {
  await openTheWall()
  await waitFor(() => {
    for (const line of census()) expect(line).not.toMatch(/=(no count|\d+\/0)$/)
  })
}

/** Panes that were left FULL by the current query. */
function fullPanes(): string[] {
  return WALL_PANE_CODES.filter(code => {
    const c = paneCount(code)
    return c !== null && c.matched === c.total
  })
}

/**
 * THE AXIS TABLE -- which panes declare each axis, and a token that exercises it.
 *
 * Hand-written on purpose: a pane's `AXES` is a module-private const, so the only
 * honest way to check the guarantee from outside is to state what each pane
 * CLAIMS to understand and then measure the grid against the claim. A pane that
 * quietly adds or drops an axis fails here, which is the point.
 *
 * Read the assertion below as the rule from `wall-filter-store`: a pane that did
 * NOT declare the axis must be left completely alone by it.
 */
const AXIS_TABLE: { axis: string; token: string; declaredBy: string[] }[] = [
  { axis: 'band', token: '!!!', declaredBy: ['P1', 'A1', 'A5'] },
  { axis: 'project', token: '@nowhere', declaredBy: ['P1', 'P2', 'P3', 'A1', 'A2', 'A4', 'A5', 'A6', 'A7', 'A8'] },
  { axis: 'tag', token: '#nope', declaredBy: ['P1', 'A1', 'A5'] },
  { axis: 'time', token: '~1m', declaredBy: ['P1', 'P2', 'P3', 'A1', 'A5'] },
  { axis: 'cost', token: '$999', declaredBy: ['P1', 'A2', 'A5', 'A6'] },
  { axis: 'context', token: '%99', declaredBy: ['P1', 'A5'] },
  { axis: 'host', token: '&nowhere', declaredBy: ['P1', 'P2', 'A1', 'A5', 'S1', 'S2'] },
  { axis: 'model', token: ':haiku', declaredBy: ['P1', 'A1', 'A5'] },
  { axis: 'managed', token: '+only', declaredBy: ['P1'] },
]

describe('the wall filter -- the grid it actually has', () => {
  it('mounts every pane the REGISTRY declares, each holding rows of its own', async () => {
    await openTheFullWall()

    // The census is READ off the registry, never typed as a number: adding a pane
    // makes this suite mount it too, so a new pane that ignores the query box
    // fails here instead of shipping quietly. (Thirteen today: twelve grid panes
    // plus A5, the NOW strip.)
    expect(WALL_PANE_CODES.length).toBeGreaterThanOrEqual(13)
    // Unfiltered, every pane is FULL and every pane has something to lose.
    expect(fullPanes()).toEqual(WALL_PANE_CODES)
  })

  it('gives each pane its OWN numbers, never the surface total', async () => {
    await openTheFullWall()

    // P4 counts TILES, P1 counts conversations, A2 counts project bars. If any
    // pane were rendering a shared surface count these would collapse to one
    // number -- which is the failure this line exists to catch.
    const totals = new Set(WALL_PANE_CODES.map(code => paneCount(code)?.total))
    expect(totals.size).toBeGreaterThan(1)

    // And under a filter the matched halves diverge too: P4 has no `project`
    // facet at all, so it keeps every tile while the project panes drop a row.
    typeQuery(`@${ANVIL_NAME}`)
    expect(paneCount('P4')).toEqual({ matched: 4, total: 4 })
    expect(paneCount('A6')?.matched).toBe(1)
  })
})

describe('an axis a pane never declared leaves that pane FULL', () => {
  for (const { axis, token, declaredBy } of AXIS_TABLE) {
    it(`${axis} (${token}) touches only the panes that declare it`, async () => {
      await openTheFullWall()
      typeQuery(token)

      // THE GUARANTEE: every pane that did not declare the axis is untouched.
      const undeclared = WALL_PANE_CODES.filter(code => !declaredBy.includes(code))
      expect(undeclared.filter(code => !fullPanes().includes(code))).toEqual([])

      // ...and the probe is not vacuous: at least one pane that DID declare the
      // axis actually moved. Without this, an axis the grammar silently dropped
      // would pass the line above by doing nothing at all.
      expect(declaredBy.some(code => !fullPanes().includes(code))).toBe(true)
    })
  }
})

describe('the project chip round-trips from every pane that renders one', () => {
  /** The chip for `name` inside `code`, re-found each time: filtering re-renders
   *  the pane, so a node captured before the click is detached after it. */
  function chip(code: string, name: string): Element | null {
    return pane(code)?.querySelector(`[data-project="${name}"]`) ?? null
  }

  /** Panes carrying a project dot, discovered in the MOUNTED DOM rather than
   *  listed here -- a pane that grows a chip is covered without editing this. */
  function chipPanes(): string[] {
    return WALL_PANE_CODES.filter(code => chip(code, ANVIL_NAME) !== null)
  }

  it('finds a project dot on every pane whose rows carry a project', async () => {
    await openTheFullWall()

    // The five without one are the five with no per-project row: A9 is a
    // fleet-wide day fold, S1 is per-node, S2 is per-account, P4 is fleet-wide
    // tiles, A5 is a stacked band.
    expect(WALL_PANE_CODES.filter(code => !chipPanes().includes(code))).toEqual(['A9', 'S2', 'S1', 'P4', 'A5'])
  })

  it('scopes the whole wall from any pane, and a second click clears it', async () => {
    await openTheFullWall()
    const sources = chipPanes()
    expect(sources.length).toBeGreaterThan(1)

    for (const code of sources) {
      fireEvent.click(chip(code, ANVIL_NAME) as Element)
      expect(`${code}:${useWallFilterStore.getState().raw}`).toBe(`${code}:@${ANVIL_NAME}`)

      // EVERY other pane re-filtered, not just the one that was clicked. The
      // panes with no project facet stay full, which is the same guarantee the
      // axis table makes, arriving through the chip instead of the keyboard.
      for (const other of sources) expect(`${other}:${paneCount(other)?.matched}`).toBe(`${other}:1`)
      // A9 sits with the three: its fold is fleet-wide, so it declares no
      // `project` axis and a scope leaves it whole.
      expect(fullPanes()).toEqual(['A9', 'S2', 'S1', 'P4'])

      // The same dot again is the way OUT. It has to be re-found: the click
      // above re-rendered the pane around it.
      fireEvent.click(chip(code, ANVIL_NAME) as Element)
      expect(`${code}:${useWallFilterStore.getState().raw}`).toBe(`${code}:`)
      expect(fullPanes()).toEqual(WALL_PANE_CODES)
    }
  })

  it('scopes to the OTHER project just as well -- the chip is not one-way', async () => {
    await openTheFullWall()
    fireEvent.click(chip('P2', RC_NAME) as Element)

    expect(useWallFilterStore.getState().raw).toBe(`@${RC_NAME}`)
    expect(chip('A6', ANVIL_NAME)).toBeNull()
    expect(chip('A6', RC_NAME)).toBeTruthy()
  })
})

describe('a query that matches nothing leaves every pane visibly empty', () => {
  /** Where each pane writes its "nothing matched" line. Every pane has one, and
   *  the point of naming them individually is that a pane which silently renders
   *  an empty box cannot be papered over by a loose selector. */
  const EMPTY_LINE: Record<string, RegExp> = {
    P1: /nothing matches/,
    P2: /no commit matches the filter/,
    P3: /no move matches the filter/,
    P4: /no tile matches the filter/,
    A1: /nothing waiting matches/,
    A2: /no project matches the filter/,
    A4: /no project matches the filter/,
    A5: /nothing matches/,
    A6: /no project matches the filter/,
    A7: /no unattended run matches/,
    A8: /no pinned epic matches/,
    A9: /no day matches the filter/,
    S1: /no node matches the filter/,
    S2: /no (profile|account|plan|line) matches/,
  }

  it('reports 0/N on every pane, never a blank surface', async () => {
    await openTheFullWall()
    const before = census()
    typeQuery('zzzznothingmatchesthis')

    // Every pane still on screen, each one saying 0 of what it HAD.
    expect(census()).toEqual(before.map(line => line.replace(/=\d+\//, '=0/')))
  })

  it('says WHY it is empty, on every pane', async () => {
    await openTheFullWall()
    typeQuery('zzzznothingmatchesthis')

    const silent = WALL_PANE_CODES.filter(code => !EMPTY_LINE[code].test(pane(code)?.textContent ?? ''))
    expect(silent).toEqual([])
  })

  it('treats an unknown token as free text -- honestly empty, not blank', async () => {
    await openTheFullWall()
    // `%>70` is NOT in the grammar (`%` takes a bare floor: `%70`). It therefore
    // falls through to free text, which every pane declares, so the WHOLE grid
    // legitimately goes to zero. That is the interesting case for this card: it
    // is the one query that empties all thirteen at once, and all thirteen still
    // carry a count and a reason rather than going blank.
    typeQuery('%>70')

    expect(fullPanes()).toEqual([])
    for (const code of WALL_PANE_CODES) {
      expect(`${code}:${paneCount(code)?.matched}`).toBe(`${code}:0`)
      expect(`${code}:${EMPTY_LINE[code].test(pane(code)?.textContent ?? '')}`).toBe(`${code}:true`)
    }
  })
})
