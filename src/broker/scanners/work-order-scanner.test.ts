import { beforeEach, describe, expect, test } from 'bun:test'
import { SYSTEM_TAGS } from '../../shared/board-system-tags'
import { EPIC_ORDERS } from '../../shared/epic-orders'
import type { ProjectTaskMeta } from '../../shared/project-task-types'
import type { Conversation } from '../../shared/protocol'
import type { TaskStatus } from '../../shared/task-statuses'
import type { EpicSpawnPlan } from '../epic-spawn-plan'
import { MAX_LAUNCH_ATTEMPTS } from '../epic-sweep'
import { runScan } from './scanner'
import { READY_TAG, WORK_ORDER_EPIC_ID, type WorkOrderDeps, workOrderScanner } from './work-order-scanner'

/**
 * NO BROKER, NO SENTINEL, NO CC PROCESS. Everything below is the scanner, the
 * two shared folds it reuses, and a plain object -- which is the contract's own
 * stated property and the reason the epic sweep is the one engine that is
 * actually tested.
 */

let seq = 0
function card(slug: string, status: TaskStatus = 'open', extra: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  seq += 1
  return {
    slug,
    status,
    title: slug,
    tags: [READY_TAG],
    refs: [],
    created: '2026-08-21T10:00:00Z',
    mtime: seq,
    bodyPreview: '',
    ...extra,
  }
}

/** A work-order seat in the registry, as `groupEpicConversations` sees it. */
function seat(cardId: string, over: Partial<Conversation> = {}, epicId = WORK_ORDER_EPIC_ID): Conversation {
  seq += 1
  return {
    id: `conv_${epicId}_${cardId}_${seq}`,
    project: 'claude://s/p',
    status: 'ended',
    launchConfig: { epic: { epicId, role: 'werk-worker', gen: 0, cardId } },
    ...over,
  } as unknown as Conversation
}

let log: string[]
let dispatched: Array<{ plan: EpicSpawnPlan; cardId: string }>

function deps(over: Partial<WorkOrderDeps> = {}): WorkOrderDeps {
  return {
    getAllConversations: () => [],
    isLive: () => false,
    log: line => log.push(line),
    now: () => 0,
    getCards: async () => [],
    producedOutput: () => true,
    concurrency: 3,
    spawnCtx: { project: 'claude://s/p', projectRoot: '/p' },
    dispatch: async (plan, cardId) => {
      dispatched.push({ plan, cardId })
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

beforeEach(() => {
  log = []
  dispatched = []
})

describe('the tag it selects on', () => {
  test('`ready` is still what the system-tag registry calls it', () => {
    expect(SYSTEM_TAGS.map(t => t.tag)).toContain(READY_TAG)
  })

  test('only `ready` cards are selected -- an untagged card is not even a refusal', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('a'), card('b', 'open', { tags: [] })] }),
    )
    expect(report.selected).toEqual(['a'])
    expect(report.acted).toEqual(['a'])
  })
})

describe('what it dispatches', () => {
  test('an authorised card gets an WERK-WORKER@1 seat', async () => {
    const report = await runScan(workOrderScanner, deps({ getCards: async () => [card('a')] }))

    expect(report.acted).toEqual(['a'])
    expect(report.unaccounted).toEqual([])
    expect(dispatched.map(d => d.cardId)).toEqual(['a'])
    const plan = dispatched[0]?.plan as EpicSpawnPlan
    expect(plan.epic).toEqual({ epicId: WORK_ORDER_EPIC_ID, role: 'werk-worker', gen: 0, cardId: 'a' })
    expect(plan.worktree).toBe(`epic/${WORK_ORDER_EPIC_ID}/a`)
    expect(plan.adHoc).toBe(true)
  })

  test("the card's own `depends_on` rides along to the seat prompt", async () => {
    await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('dep', 'done', { tags: [] }), card('a', 'open', { dependsOn: ['dep'] })] }),
    )
    expect(dispatched[0]?.plan.prompt).toContain('dep')
  })

  test("a seat is tagged with the RESERVED lane, never with the card's own epic", async () => {
    await runScan(workOrderScanner, deps({ getCards: async () => [card('a')] }))
    expect(dispatched[0]?.plan.epic.epicId).toBe(WORK_ORDER_EPIC_ID)
  })

  test('a re-authorised card dispatches under the next attempt number', async () => {
    // Settled seats normally refuse the card (`already-run`); one that produced
    // nothing does not settle it, so this is the retry path in the shared fold.
    const report = await runScan(
      workOrderScanner,
      deps({
        getCards: async () => [card('a')],
        getAllConversations: () => [seat('a')],
        producedOutput: () => false,
      }),
    )
    expect(report.acted).toEqual(['a'])
    expect(dispatched[0]?.plan.epic.gen).toBe(1)
  })

  /**
   * THE CARD'S `model:` HINT REACHES THE SEAT, NARROWED.
   *
   * `WERK-WORKER@1` declares a real tier since `werk-seat-model-policy`, so the
   * clamp now has something to narrow against and this is the pair's downward
   * half: a hint the seat allows is the choice, and the seat's own tier is what
   * a card that said nothing gets.
   */
  test("a card's `model:` hint becomes the seat's model", async () => {
    await runScan(workOrderScanner, deps({ getCards: async () => [card('a', 'open', { model: 'haiku' })] }))

    expect(dispatched[0]?.plan.model).toBe('haiku')
  })

  /**
   * WAS "leaves the seat on the project default, exactly as before", and the
   * project default is exactly what a seat no longer resolves to: an unhinted
   * werk-worker used to inherit whatever a machine's spawn config happened to
   * say, which is a cost decision nobody committed. It now runs the tier its
   * order names.
   */
  test("a card with no hint runs at the seat's own declared tier", async () => {
    await runScan(workOrderScanner, deps({ getCards: async () => [card('a')] }))

    expect(dispatched[0]?.plan.model).toBe(EPIC_ORDERS['werk-worker'].caps.model)
    expect(dispatched[0]?.plan.model).toBeTruthy()
  })

  /** The direction that may never happen: a card cannot buy a tier its seat
   *  refused it. The clamp says so in the log rather than silently. */
  test('a card asking above the seat runs at the cap, and the clamp is logged', async () => {
    await runScan(workOrderScanner, deps({ getCards: async () => [card('a', 'open', { model: 'fable' })] }))

    expect(dispatched[0]?.plan.model).toBe(EPIC_ORDERS['werk-worker'].caps.model)
    expect(log.join('\n')).toContain('asks for more than')
  })
})

describe('what it refuses, and by what name', () => {
  test('a card with a live seat is skipped -- the shared rule', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('a')], getAllConversations: () => [seat('a')], isLive: () => true }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)).toEqual({ 'live-conversation': ['a'] })
  })

  test('a card belonging to an epic is left to that epic run', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('a', 'open', { tags: [READY_TAG], epic: 'epic-x' })] }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['epic-owned']).toEqual(['a'])
    expect(report.refused[0]?.detail).toContain('epic-x')
  })

  test('a card whose seat already ran is NOT dispatched again -- the billing bound', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('a')], getAllConversations: () => [seat('a')] }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['already-run']).toEqual(['a'])
  })

  test('an unfinished dependency holds the card back, and the reason names it', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('a', 'open', { dependsOn: ['nope'] })] }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['waiting-on-deps']).toEqual(['a'])
    expect(report.refused[0]?.detail).toContain('nope')
  })

  test('the concurrency ceiling holds the surplus rather than truncating it', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ concurrency: 2, getCards: async () => [card('a'), card('b'), card('c'), card('d')] }),
    )
    expect(report.acted).toEqual(['a', 'b'])
    expect(buckets(report.refused)['held-back']).toEqual(['c', 'd'])
    expect(report.unaccounted).toEqual([])
  })

  test('a live seat eats a slot, so the ceiling counts what is running too', async () => {
    const report = await runScan(
      workOrderScanner,
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

  test('a question card is answered by the werk-master, never implemented', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('q', 'open', { tags: [READY_TAG, 'needs-werk-master'] })] }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['needs-werk-master']).toEqual(['q'])
  })

  test('a card whose seats keep dying is not retried forever', async () => {
    const dead = Array.from({ length: MAX_LAUNCH_ATTEMPTS }, () => seat('a'))
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('a')], getAllConversations: () => dead, producedOutput: () => false }),
    )
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['unspawnable']).toEqual(['a'])
  })

  test('an in-review card waits for a verdict -- this scanner dispatches werk-workers only', async () => {
    const report = await runScan(workOrderScanner, deps({ getCards: async () => [card('a', 'in-review')] }))
    expect(dispatched).toEqual([])
    expect(buckets(report.refused)['awaiting-verdict']).toEqual(['a'])
  })

  test('a `ready` card in a lane nothing acts on still gets a name and a count', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('done', 'done'), card('gone', 'archived'), card('busy', 'in-progress')] }),
    )
    expect(buckets(report.refused)['not-actionable']?.sort()).toEqual(['busy', 'done', 'gone'])
    expect(report.unaccounted).toEqual([])
  })

  test('a refused spawn is a refusal, not an action', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => [card('a')], dispatch: async () => false }),
    )
    expect(report.acted).toEqual([])
    expect(buckets(report.refused)['dispatch-failed']).toEqual(['a'])
  })

  test('a dispatch that THROWS takes only its own card down', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({
        getCards: async () => [card('a'), card('b')],
        dispatch: async (_plan, cardId) => {
          if (cardId === 'a') throw new Error('sentinel is down')
          dispatched.push({ plan: _plan, cardId })
          return true
        },
      }),
    )
    expect(report.acted).toEqual(['b'])
    expect(buckets(report.refused)['dispatch-failed']).toEqual(['a'])
    expect(log.join('\n')).toContain('[work-order] dispatch threw for a: sentinel is down')
  })
})

describe('an EARLY-REFUSED card is still `done` for everything that depends on it', () => {
  /**
   * THE STEADY-STATE DEADLOCK (B1). The three early refusals -- `epic-owned`,
   * `live-conversation`, `already-run` -- used to be filtered out of the array
   * handed to `planTagged`, which is also the array `doneCardIds` is computed
   * from. So a refused card stopped counting as finished, and every `ready` card
   * depending on it was refused `waiting-on-deps` naming a dependency that is
   * `done` -- every tick, forever.
   *
   * `already-run` is what ARMS it in normal operation: dispatch a card, its seat
   * settles, the card keeps its `ready` tag, and from the next tick onwards it is
   * early-refused on every pass.
   *
   * Each test below has a `done` dependency behind one early refusal. The last
   * one is the CONTROL: same board, nothing early-refused, and it already passed
   * before the fix -- which is what makes the other three assertions real.
   */
  const dependent = () => [card('dep', 'done'), card('a', 'open', { dependsOn: ['dep'] })]

  test('`already-run`: the settled dependency is done, so its dependent dispatches', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => dependent(), getAllConversations: () => [seat('dep')] }),
    )
    expect(buckets(report.refused)['already-run']).toEqual(['dep'])
    expect(buckets(report.refused)['waiting-on-deps']).toBeUndefined()
    expect(report.acted).toEqual(['a'])
  })

  test('`epic-owned`: an epic card that is done still satisfies a dependency here', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({
        getCards: async () => [
          card('dep', 'done', { tags: [READY_TAG], epic: 'e' }),
          card('a', 'open', { dependsOn: ['dep'] }),
        ],
      }),
    )
    expect(buckets(report.refused)['epic-owned']).toEqual(['dep'])
    expect(buckets(report.refused)['waiting-on-deps']).toBeUndefined()
    expect(report.acted).toEqual(['a'])
  })

  test('`live-conversation`: a dependency with a live seat is skipped, not erased', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({ getCards: async () => dependent(), getAllConversations: () => [seat('dep')], isLive: () => true }),
    )
    expect(buckets(report.refused)['live-conversation']).toEqual(['dep'])
    expect(buckets(report.refused)['waiting-on-deps']).toBeUndefined()
    expect(report.acted).toEqual(['a'])
  })

  test('CONTROL -- the same board with nothing early-refused behaves identically', async () => {
    const report = await runScan(workOrderScanner, deps({ getCards: async () => dependent() }))
    expect(buckets(report.refused)['not-actionable']).toEqual(['dep'])
    expect(buckets(report.refused)['waiting-on-deps']).toBeUndefined()
    expect(report.acted).toEqual(['a'])
  })

  test('a dependency that is genuinely unfinished still holds its dependent back', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({
        getCards: async () => [card('dep', 'open'), card('a', 'open', { dependsOn: ['dep'] })],
        getAllConversations: () => [seat('dep')],
      }),
    )
    expect(buckets(report.refused)['already-run']).toEqual(['dep'])
    expect(buckets(report.refused)['waiting-on-deps']).toEqual(['a'])
    expect(report.acted).toEqual([])
  })
})

describe('the accounting -- no `ready` card is ever dropped', () => {
  test('every selected card is acted on or refused, across every bucket at once', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({
        concurrency: 1,
        getCards: async () => [
          card('go'),
          card('surplus'),
          card('owned', 'open', { tags: [READY_TAG], epic: 'e' }),
          card('waiting', 'open', { dependsOn: ['never'] }),
          card('question', 'open', { tags: [READY_TAG, 'needs-werk-master'] }),
          card('review', 'in-review'),
          card('finished', 'done'),
        ],
      }),
    )
    expect(report.selected.length).toBe(7)
    expect(report.unaccounted).toEqual([])
    expect(log).toEqual([])
  })

  test('an empty board is idle with a reason, not silent', async () => {
    const report = await runScan(workOrderScanner, deps())
    expect(report.selected).toEqual([])
    expect(report.idleReason).toContain(READY_TAG)
  })

  test('a pass that dispatched something reports no idle reason', async () => {
    const report = await runScan(workOrderScanner, deps({ getCards: async () => [card('a')] }))
    expect(report.idleReason).toBeUndefined()
  })

  test('a board read that throws is swallowed and reported, not fatal', async () => {
    const report = await runScan(
      workOrderScanner,
      deps({
        getCards: async () => {
          throw new Error('sentinel unreachable')
        },
      }),
    )
    expect(report.crashed).toBe('sentinel unreachable')
    expect(report.scanner).toBe('work-order')
    expect(log.join('\n')).toContain('[work-order] scan crashed')
  })
})
