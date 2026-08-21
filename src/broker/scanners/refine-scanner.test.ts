import { beforeEach, describe, expect, test } from 'bun:test'
import { SYSTEM_TAGS } from '../../shared/board-system-tags'
import { NEEDS_REFINE_TAG } from '../../shared/epic-ready'
import { EPIC_ROSTER_HEADER } from '../../shared/epic-roster'
import { composeSeatPrompt } from '../../shared/order'
import type { ProjectTaskMeta } from '../../shared/project-task-types'
import type { Conversation } from '../../shared/protocol'
import { REFINER_ORDER, REFINER_ORDER_ID } from '../../shared/refiner-order'
import type { SpawnRequest } from '../../shared/spawn-schema'
import type { TaskStatus } from '../../shared/task-statuses'
import { MAX_LAUNCH_ATTEMPTS } from '../epic-sweep'
import { DEFAULT_REFINE_CONCURRENCY, REFINE_EPIC_ID, type RefineDeps, refineScanner } from './refine-scanner'
import { runScan } from './scanner'

/**
 * NO BROKER, NO SENTINEL, NO CC PROCESS. Everything below is the scanner, the
 * shared folds it reuses and a plain object -- the contract's own stated
 * property, and the reason the epic sweep is the one engine that is tested.
 */

let seq = 0
function card(slug: string, status: TaskStatus = 'open', extra: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  seq += 1
  return {
    slug,
    status,
    title: slug,
    tags: [NEEDS_REFINE_TAG],
    refs: [],
    created: '2026-08-21T10:00:00Z',
    mtime: seq,
    bodyPreview: '',
    ...extra,
  }
}

/** A refiner seat in the registry, as `groupEpicConversations` sees it. */
function seat(cardId: string, over: Partial<Conversation> = {}, epicId = REFINE_EPIC_ID): Conversation {
  seq += 1
  return {
    id: `conv_${epicId}_${cardId}_${seq}`,
    project: 'claude://s/p',
    status: 'ended',
    launchConfig: { epic: { epicId, role: 'implementer', gen: 0, cardId } },
    ...over,
  } as unknown as Conversation
}

let log: string[]
let dispatched: Array<{ request: SpawnRequest; cardId: string }>

function deps(over: Partial<RefineDeps> = {}): RefineDeps {
  return {
    getAllConversations: () => [],
    isLive: () => false,
    log: line => log.push(line),
    now: () => 0,
    getCards: async () => [],
    producedOutput: () => true,
    concurrency: 3,
    project: 'claude://s/p',
    projectRoot: '/p',
    dispatch: async (request, cardId) => {
      dispatched.push({ request, cardId })
      return true
    },
    ...over,
  }
}

/** Every unit refused, by bucket -- the shape a pane would render. */
function buckets(refused: readonly { unit: string; bucket: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of refused) {
    const list = out[r.bucket] ?? []
    list.push(r.unit)
    out[r.bucket] = list
  }
  return out
}

/** The deny rules that reached the seat's settings fragment. */
function denyRules(request: SpawnRequest): string[] {
  const permissions = (request.settingsInline ?? {}).permissions as { deny?: string[] } | undefined
  return permissions?.deny ?? []
}

beforeEach(() => {
  log = []
  dispatched = []
})

describe('the tag it drains', () => {
  test('`needs-refine` is still what the system-tag registry calls it', () => {
    expect(SYSTEM_TAGS.map(t => t.tag)).toContain(NEEDS_REFINE_TAG)
  })

  test('only tagged cards are selected -- an untagged card is not even a refusal', async () => {
    const report = await runScan(
      refineScanner,
      deps({ getCards: async () => [card('a'), card('b', 'open', { tags: [] })] }),
    )
    expect(report.selected).toEqual(['a'])
    expect(report.acted).toEqual(['a'])
  })
})

describe('the seat it dispatches is REFINER@1, not a second definition of one', () => {
  test('a rough card gets a refiner carrying the order caps', async () => {
    const report = await runScan(refineScanner, deps({ getCards: async () => [card('a')] }))

    expect(report.acted).toEqual(['a'])
    expect(report.unaccounted).toEqual([])
    const request = dispatched[0]?.request as SpawnRequest
    expect(request.model).toBe(REFINER_ORDER.caps.model)
    expect(request.effort).toBe(REFINER_ORDER.caps.effort)
    expect(request.maxBudgetUsd).toBe(REFINER_ORDER.caps.maxBudgetUsd)
    // The turn ceiling rides the same seam as the budget now that it is a cap
    // rather than a number on a wrapper nothing read.
    expect(request.maxTurns).toBe(REFINER_ORDER.caps.maxTurns)
    expect(request.adHoc).toBe(true)
    expect(request.headless).toBe(true)
  })

  /**
   * THE ONE GUARANTEE THAT MATTERS. `flipsStatus: false` in `TASK_MODES` is a
   * flag a prompt builder may or may not honour; the order's deny rule is the
   * same rule enforced by the harness. A refiner that moved a card to in-review
   * would be lying on the board about work that never happened.
   */
  test("the order's deny on the status verb reaches the seat", async () => {
    await runScan(refineScanner, deps({ getCards: async () => [card('a')] }))
    expect(denyRules(dispatched[0]?.request as SpawnRequest)).toContain('mcp__rclaude__project_set_status')
  })

  test("the unattended deny FLOOR rides along with the order's own rules", async () => {
    await runScan(refineScanner, deps({ getCards: async () => [card('a')] }))
    const deny = denyRules(dispatched[0]?.request as SpawnRequest)
    expect(deny.some(rule => rule.includes('push'))).toBe(true)
    expect(deny).toContain('mcp__rclaude__project_set_status')
  })

  test("the project's own deny rules are kept, not replaced by the order's", async () => {
    await runScan(refineScanner, deps({ getCards: async () => [card('a')], permissions: { deny: ['Bash(rm:*)'] } }))
    const deny = denyRules(dispatched[0]?.request as SpawnRequest)
    expect(deny).toContain('Bash(rm:*)')
    expect(deny).toContain('mcp__rclaude__project_set_status')
  })

  /** The tag removal is step 7 of `REFINER_INSTRUCTIONS`, imported rather than
   *  restated -- the drain is the whole point and a second copy of the prose is
   *  the drift this epic exists to end. */
  test('the prompt orders the tag removed, and names the card file', async () => {
    await runScan(refineScanner, deps({ getCards: async () => [card('rough-card')] }))
    const prompt = dispatched[0]?.request.prompt ?? ''
    expect(prompt).toContain('/p/.rclaude/project/cards/rough-card.md')
    expect(prompt).toContain(NEEDS_REFINE_TAG)
    expect(prompt).toContain('REMOVE')
  })

  /**
   * THE SEAM, not the text. This scanner builds only the CONTEXT half -- which
   * card, which file, the roster -- and the instruction half comes off the ORDER
   * through `composeSeatPrompt`, the one function the scheduler's
   * `buildSpawnRequest` also calls.
   *
   * The assertion is on the WHOLE prompt, deliberately, because that is the only
   * shape that catches the failure this pins. Re-deriving the block from the
   * `REFINER_INSTRUCTIONS` constant reads the same bytes TODAY -- so a
   * `toContain` would pass either way -- but an order edited to carry a
   * different block would then move the scheduler's seat and not this one, and
   * this test fails the moment the two sources disagree.
   */
  test("the prompt is the scanner's own context composed with the ORDER's block", async () => {
    await runScan(refineScanner, deps({ getCards: async () => [card('rough-card')] }))
    const context = [
      'REFINE the board card `rough-card`.',
      '',
      'Card file: /p/.rclaude/project/cards/rough-card.md',
    ].join('\n')
    expect(REFINER_ORDER.instructions).toBeTruthy()
    expect(dispatched[0]?.request.prompt).toBe(composeSeatPrompt(REFINER_ORDER, context))
  })

  test("a seat is tagged with the RESERVED lane, never with the card's own epic", async () => {
    await runScan(refineScanner, deps({ getCards: async () => [card('a', 'open', { epic: 'epic-x' })] }))
    expect(dispatched[0]?.request.epic?.epicId).toBe(REFINE_EPIC_ID)
    expect(dispatched[0]?.request.epic?.cardId).toBe('a')
  })

  test("the ceiling is the order's reservation, not a number picked here", () => {
    // `Order.reservation` is optional, so this also pins that `REFINER@1` still
    // DECLARES one -- a dropped declaration would silently fall back to 1 here
    // and the assertion would pass against a number nobody wrote down.
    expect(REFINER_ORDER.reservation).toBeDefined()
    expect(DEFAULT_REFINE_CONCURRENCY).toBe(REFINER_ORDER.reservation as number)
  })

  /**
   * THE MODEL HINT IS A HINT, AND THE ORDER STILL WINS.
   *
   * `composeOrderCaps` treats `model` as a SELECTION field where an explicit
   * base wins outright -- which is right for a human at a spawn dialog and would
   * be a hole here: a card would buy itself a tier its seat's order refused. The
   * clamp runs before the composition ever sees the value.
   */
  test('a `model: opus` card dispatched by REFINER@1 still runs on Haiku', async () => {
    await runScan(refineScanner, deps({ getCards: async () => [card('a', 'open', { model: 'opus' })] }))

    expect(dispatched[0]?.request.model).toBe(REFINER_ORDER.caps.model)
  })

  test('a clamp is LOGGED -- a silent downgrade is the failure this exists to avoid', async () => {
    await runScan(refineScanner, deps({ getCards: async () => [card('a', 'open', { model: 'opus' })] }))

    expect(log.some(line => line.includes('opus') && line.includes(String(REFINER_ORDER.caps.model)))).toBe(true)
  })

  test('a hint AT the cap survives, and says nothing about it', async () => {
    await runScan(
      refineScanner,
      deps({ getCards: async () => [card('a', 'open', { model: REFINER_ORDER.caps.model })] }),
    )

    expect(dispatched[0]?.request.model).toBe(REFINER_ORDER.caps.model)
    expect(log.some(line => line.includes('running on'))).toBe(false)
  })

  test('a card with no hint dispatches exactly as it always did', async () => {
    await runScan(refineScanner, deps({ getCards: async () => [card('a')] }))

    expect(dispatched[0]?.request.model).toBe(REFINER_ORDER.caps.model)
    expect(log.some(line => line.includes('running on'))).toBe(false)
  })

  test('a re-tagged card dispatches under the next attempt number, so the name is new', async () => {
    // A settled seat normally refuses the card (`already-run`); one that produced
    // nothing does not settle it, so this is the retry path in the shared fold.
    const report = await runScan(
      refineScanner,
      deps({ getCards: async () => [card('a')], getAllConversations: () => [seat('a')], producedOutput: () => false }),
    )
    expect(report.acted).toEqual(['a'])
    expect(dispatched[0]?.request.epic?.gen).toBe(1)
    expect(dispatched[0]?.request.name).toContain('g1')
  })
})

describe('what it refuses, and by what name', () => {
  test('a card with a live refiner is skipped', async () => {
    const report = await runScan(
      refineScanner,
      deps({ getCards: async () => [card('a')], getAllConversations: () => [seat('a')], isLive: () => true }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)).toEqual({ 'live-conversation': ['a'] })
  })

  /**
   * THE DRAIN'S OWN BOUND. The tag IS the queue, so a refiner that finished
   * without removing it would otherwise be re-dispatched on every tick forever
   * -- the exact "spawn per card without a ceiling" the card forbids.
   */
  test('a card whose refiner already ran is NOT dispatched again', async () => {
    const report = await runScan(
      refineScanner,
      deps({ getCards: async () => [card('a')], getAllConversations: () => [seat('a')] }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['already-run']).toEqual(['a'])
    expect(report.idleReason).toContain('re-tag')
  })

  test('a card someone is already building is not rewritten under them', async () => {
    const report = await runScan(
      refineScanner,
      deps({ getCards: async () => [card('busy', 'in-progress'), card('judging', 'in-review')] }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['not-actionable']?.sort()).toEqual(['busy', 'judging'])
  })

  test('a tag left on a finished card is history, not a queue entry', async () => {
    const report = await runScan(
      refineScanner,
      deps({ getCards: async () => [card('done', 'done'), card('gone', 'archived')] }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['not-actionable']?.sort()).toEqual(['done', 'gone'])
    expect(report.unaccounted).toEqual([])
  })

  test('a card whose refiners keep dying is not retried forever', async () => {
    const dead = Array.from({ length: MAX_LAUNCH_ATTEMPTS }, () => seat('a'))
    const report = await runScan(
      refineScanner,
      deps({ getCards: async () => [card('a')], getAllConversations: () => dead, producedOutput: () => false }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['unspawnable']).toEqual(['a'])
  })

  test('a backlog does not consume every seat -- the surplus is held, not truncated', async () => {
    const report = await runScan(
      refineScanner,
      deps({
        concurrency: DEFAULT_REFINE_CONCURRENCY,
        getCards: async () => Array.from({ length: 40 }, (_, i) => card(`c${i}`)),
      }),
    )
    expect(report.acted.length).toBe(DEFAULT_REFINE_CONCURRENCY)
    expect(buckets(report.refused)['held-back']?.length).toBe(40 - DEFAULT_REFINE_CONCURRENCY)
    expect(report.unaccounted).toEqual([])
  })

  test('a live refiner eats a slot, so the ceiling counts what is running too', async () => {
    const report = await runScan(
      refineScanner,
      deps({
        concurrency: 2,
        getCards: async () => [card('live'), card('a'), card('b')],
        getAllConversations: () => [seat('live')],
        isLive: () => true,
      }),
    )
    expect(report.acted).toEqual(['a'])
    expect(buckets(report.refused)).toEqual({ 'live-conversation': ['live'], 'held-back': ['b'] })
  })

  test('an unfinished dependency does NOT hold a rough card back -- refining is not implementing', async () => {
    const report = await runScan(
      refineScanner,
      deps({ getCards: async () => [card('dep', 'open', { tags: [] }), card('a', 'open', { dependsOn: ['dep'] })] }),
    )
    expect(report.acted).toEqual(['a'])
  })

  test('a refused spawn is a refusal, not an action', async () => {
    const report = await runScan(
      refineScanner,
      deps({ getCards: async () => [card('a')], dispatch: async () => false }),
    )
    expect(report.acted).toEqual([])
    expect(buckets(report.refused)['dispatch-failed']).toEqual(['a'])
  })

  test('a dispatch that THROWS takes only its own card down', async () => {
    const report = await runScan(
      refineScanner,
      deps({
        getCards: async () => [card('a'), card('b')],
        dispatch: async (request, cardId) => {
          if (cardId === 'a') throw new Error('sentinel is down')
          dispatched.push({ request, cardId })
          return true
        },
      }),
    )
    expect(report.acted).toEqual(['b'])
    expect(buckets(report.refused)['dispatch-failed']).toEqual(['a'])
    expect(log.join('\n')).toContain('[refine] dispatch threw for a: sentinel is down')
  })

  /**
   * A settings fragment the order's deny rules CANNOT be unioned into must not
   * produce a refiner that quietly regained the status verb -- the one outcome
   * worse than not dispatching at all.
   *
   * Reachable because per-project permissions are JSON off disk: a hand-edited
   * `deny` list carrying a number is exactly the shape that gets here.
   */
  test('a fragment the order cannot be applied to refuses the card, naming the order', async () => {
    const report = await runScan(
      refineScanner,
      deps({
        getCards: async () => [card('a')],
        permissions: { deny: [7 as unknown as string] },
        dispatch: async () => {
          throw new Error('a seat must not be dispatched when its order could not be applied')
        },
      }),
    )
    expect(report.acted).toEqual([])
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['order-refused']).toEqual(['a'])
    expect(report.refused[0]?.detail).toContain(REFINER_ORDER_ID)
  })
})

describe('the accounting -- no rough card is ever dropped', () => {
  test('every selected card is acted on or refused, across every bucket at once', async () => {
    const report = await runScan(
      refineScanner,
      deps({
        concurrency: 1,
        getCards: async () => [
          card('go'),
          card('surplus'),
          card('busy', 'in-progress'),
          card('finished', 'done'),
          card('ran'),
        ],
        getAllConversations: () => [seat('ran')],
      }),
    )
    expect(report.selected.length).toBe(5)
    expect(report.unaccounted).toEqual([])
    expect(log).toEqual([])
    expect(buckets(report.refused)).toEqual({
      'not-actionable': ['busy', 'finished'],
      'already-run': ['ran'],
      'held-back': ['surplus'],
    })
    expect(report.acted).toEqual(['go'])
  })

  test('an empty board is idle with a reason, not silent', async () => {
    const report = await runScan(refineScanner, deps())
    expect(report.selected).toEqual([])
    expect(report.idleReason).toContain(NEEDS_REFINE_TAG)
  })

  test('a pass that dispatched something reports no idle reason', async () => {
    const report = await runScan(refineScanner, deps({ getCards: async () => [card('a')] }))
    expect(report.idleReason).toBeUndefined()
  })

  test('a board read that throws is swallowed and reported, not fatal', async () => {
    const report = await runScan(
      refineScanner,
      deps({
        getCards: async () => {
          throw new Error('sentinel unreachable')
        },
      }),
    )
    expect(report.crashed).toBe('sentinel unreachable')
    expect(report.scanner).toBe('refine')
    expect(log.join('\n')).toContain('[refine] scan crashed')
  })
})

/**
 * THE OPEN-EPIC ROSTER, the only board context a refiner seat ever gets.
 *
 * A refiner is handed ONE card. Without the roster it cannot set `epic:` on an
 * orphan without going and reading the whole board itself -- which a Haiku seat
 * on a $0.50 budget will not reliably do, and which nothing in its instructions
 * told it to do.
 */
describe('the roster of epics the seat may soft-link the card to', () => {
  test('an orphan card is told which epics are open', async () => {
    const cards = [
      card('rough-card'),
      card('epic-scanner-fabric', 'open', { tags: ['epic'], title: 'The scanner fabric' }),
    ]
    await runScan(refineScanner, deps({ getCards: async () => cards }))
    const prompt = dispatched[0]?.request.prompt ?? ''
    expect(prompt).toContain(EPIC_ROSTER_HEADER)
    expect(prompt).toContain('- epic-scanner-fabric -- The scanner fabric')
  })

  test('a card that already has an epic gets no roster -- prompt weight that changes nothing', async () => {
    const cards = [card('rough-card', 'open', { epic: 'epic-a' }), card('epic-a', 'open', { tags: ['epic'] })]
    await runScan(refineScanner, deps({ getCards: async () => cards }))
    expect(dispatched[0]?.request.prompt ?? '').not.toContain(EPIC_ROSTER_HEADER)
  })

  test('a board with no open epic emits no block, not a blank one', async () => {
    const cards = [card('rough-card'), card('shipped', 'done', { tags: ['epic'] })]
    await runScan(refineScanner, deps({ getCards: async () => cards }))
    const prompt = dispatched[0]?.request.prompt ?? ''
    expect(prompt).not.toContain(EPIC_ROSTER_HEADER)
    expect(prompt).not.toContain('\n\n\n')
  })

  test('the roster is bounded on a board carrying 60 epics', async () => {
    const cards = [
      card('rough-card'),
      ...Array.from({ length: 60 }, (_, i) => card(`e${i}`, 'open', { tags: ['epic'] })),
    ]
    await runScan(refineScanner, deps({ getCards: async () => cards }))
    const prompt = dispatched[0]?.request.prompt ?? ''
    expect(prompt.split('\n').filter(l => /^- e\d+ --/.test(l)).length).toBeLessThanOrEqual(40)
    expect(prompt).toContain('more open epic(s) not listed here')
  })

  test('the card, its file and the instructions all survive the roster', async () => {
    const cards = [card('rough-card'), card('epic-a', 'open', { tags: ['epic'] })]
    await runScan(refineScanner, deps({ getCards: async () => cards }))
    const prompt = dispatched[0]?.request.prompt ?? ''
    expect(prompt).toContain('REFINE the board card `rough-card`')
    expect(prompt).toContain('/p/.rclaude/project/cards/rough-card.md')
    expect(prompt).toContain('REMOVE')
  })

  /** The roster is CONTEXT, so it rides in the half this scanner owns and lands
   *  ahead of the order's block -- a seat reads its standing rules against a
   *  target it already has. */
  test("the roster sits in the context half, ahead of the order's block", async () => {
    const cards = [card('rough-card'), card('epic-a', 'open', { tags: ['epic'] })]
    await runScan(refineScanner, deps({ getCards: async () => cards }))
    const prompt = dispatched[0]?.request.prompt ?? ''
    const instructions = REFINER_ORDER.instructions ?? ''
    expect(prompt.indexOf(EPIC_ROSTER_HEADER)).toBeGreaterThan(-1)
    expect(prompt.indexOf(EPIC_ROSTER_HEADER)).toBeLessThan(prompt.indexOf(instructions))
  })

  test('it says out loud that a wrong parent is worse than none', async () => {
    const cards = [card('rough-card'), card('epic-a', 'open', { tags: ['epic'] })]
    await runScan(refineScanner, deps({ getCards: async () => cards }))
    expect(dispatched[0]?.request.prompt ?? '').toContain('Not sure? Leave it unset')
  })
})
