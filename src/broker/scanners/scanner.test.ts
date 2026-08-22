import { describe, expect, test } from 'bun:test'
import type { Conversation } from '../../shared/protocol'
import { type Refusal, runScan, type Scanner, type ScannerDeps, unaccountedUnits } from './scanner'

/**
 * A SECOND IMPLEMENTATION, written against the contract alone.
 *
 * This is the card's actual acceptance test, not a mock: nothing below imports a
 * broker module, a store, a sentinel or an epic. If a scanner can be written and
 * exercised from `scanner.ts` plus a plain object, the contract is reusable; if
 * it needed one broker internal, it would not be.
 *
 * It also demonstrates the shape the four carded scanners will take -- select by
 * tag, skip anything with a live conversation, refuse everything else by name.
 */
type DemoBucket = 'live-conversation' | 'untagged'

interface DemoDeps extends ScannerDeps {
  /** The board, reduced to what a tag-driven scanner needs. */
  cards: () => Array<{ slug: string; tags: string[] }>
  dispatched: string[]
}

const demoScanner: Scanner<DemoDeps, DemoBucket> = {
  id: 'refine',
  tag: '[demo]',
  selects: '#needs-refine',
  does: 'dispatch',
  buckets: ['live-conversation', 'untagged'],
  scan: async deps => {
    const cards = deps.cards()
    const live = new Set(
      deps
        .getAllConversations()
        .filter(c => deps.isLive(c))
        .map(c => c.id),
    )
    const acted: string[] = []
    const refused: Refusal<DemoBucket>[] = []
    for (const card of cards) {
      if (!card.tags.includes('needs-refine')) {
        refused.push({ unit: card.slug, bucket: 'untagged', detail: 'no #needs-refine tag' })
        continue
      }
      if (live.has(card.slug)) {
        refused.push({ unit: card.slug, bucket: 'live-conversation', detail: 'someone is working it' })
        continue
      }
      deps.dispatched.push(card.slug)
      acted.push(card.slug)
    }
    return { selected: cards.map(c => c.slug), acted, refused }
  },
}

function demoDeps(overrides: Partial<DemoDeps> = {}): DemoDeps {
  return {
    getAllConversations: () => [],
    isLive: () => false,
    log: () => {},
    now: () => 0,
    cards: () => [],
    dispatched: [],
    ...overrides,
  }
}

/** A conversation whose id IS the card it is working -- enough for a liveness
 *  predicate, and it keeps the fixture honest about what a scanner reads. */
function conv(id: string): Conversation {
  return { id, project: 'claude://s/p', status: 'running' } as unknown as Conversation
}

describe('a scanner written against the contract alone', () => {
  test('dispatches the tagged cards and names a bucket for every other one', async () => {
    const deps = demoDeps({
      cards: () => [
        { slug: 'a', tags: ['needs-refine'] },
        { slug: 'b', tags: [] },
        { slug: 'c', tags: ['needs-refine'] },
      ],
      getAllConversations: () => [conv('c')],
      isLive: () => true,
    })
    const report = await runScan(demoScanner, deps)

    expect(report.acted).toEqual(['a'])
    expect(deps.dispatched).toEqual(['a'])
    expect(report.refused).toEqual([
      { unit: 'b', bucket: 'untagged', detail: 'no #needs-refine tag' },
      { unit: 'c', bucket: 'live-conversation', detail: 'someone is working it' },
    ])
  })

  test('a card with a live conversation is left alone -- the shared rule', async () => {
    const deps = demoDeps({
      cards: () => [{ slug: 'a', tags: ['needs-refine'] }],
      getAllConversations: () => [conv('a')],
      isLive: () => true,
    })
    await runScan(demoScanner, deps)
    expect(deps.dispatched).toEqual([])
  })

  test('reports which scanner produced the pass', async () => {
    const report = await runScan(demoScanner, demoDeps())
    expect(report.scanner).toBe('refine')
  })
})

describe('the accounting pass -- a scanner cannot drop a unit silently', () => {
  test('a selected unit that is neither acted on nor refused is surfaced', () => {
    expect(unaccountedUnits({ selected: ['a', 'b', 'c'], acted: ['a'], refused: [] })).toEqual(['b', 'c'])
  })

  test('acted and refused together cover the selection -- nothing unaccounted', () => {
    expect(
      unaccountedUnits({
        selected: ['a', 'b'],
        acted: ['a'],
        refused: [{ unit: 'b', bucket: 'untagged', detail: 'x' }],
      }),
    ).toEqual([])
  })

  test('runScan says so LOUDLY, naming the units and the buckets that were available', async () => {
    const log: string[] = []
    const dropper: Scanner<ScannerDeps, 'untagged'> = {
      id: 'nightshift',
      tag: '[dropper]',
      selects: '#nightshift',
      does: 'dispatch',
      buckets: ['untagged'],
      scan: async () => ({ selected: ['a', 'b'], acted: [], refused: [] }),
    }
    const report = await runScan(dropper, { ...demoDeps(), log: line => log.push(line) })

    expect(report.unaccounted).toEqual(['a', 'b'])
    expect(log.join('\n')).toContain('[dropper] DROPPED 2 unit(s) with no reason given: a, b')
    expect(log.join('\n')).toContain('[untagged]')
  })

  test('a healthy pass logs NOTHING -- this runs every 45s', async () => {
    const log: string[] = []
    await runScan(demoScanner, demoDeps({ cards: () => [{ slug: 'a', tags: [] }], log: line => log.push(line) }))
    expect(log).toEqual([])
  })
})

describe('self-catching', () => {
  test('a scan that throws is swallowed, logged, and reported as crashed', async () => {
    const log: string[] = []
    const boom: Scanner<ScannerDeps, 'untagged'> = {
      id: 'morning-report',
      tag: '[boom]',
      selects: 'everything',
      does: 'propose',
      buckets: ['untagged'],
      scan: async () => {
        throw new Error('sentinel exploded')
      },
    }
    const report = await runScan(boom, { ...demoDeps(), log: line => log.push(line) })

    expect(report.crashed).toBe('sentinel exploded')
    expect(report.selected).toEqual([])
    expect(report.unaccounted).toEqual([])
    expect(log.join('\n')).toContain('[boom] scan crashed -- swallowing: sentinel exploded')
  })

  test('a non-Error throw still produces a message rather than `undefined`', async () => {
    const boom: Scanner<ScannerDeps, 'untagged'> = {
      id: 'work-order',
      tag: '[boom]',
      selects: '#ready',
      does: 'dispatch',
      buckets: ['untagged'],
      scan: async () => {
        throw 'a bare string'
      },
    }
    expect((await runScan(boom, demoDeps())).crashed).toBe('a bare string')
  })
})
