/**
 * A SEAT THAT ENDS WITHOUT MOVING ITS CARD, END TO END.
 *
 * The registry folds the conversations, the beat acts on the fold. Both halves
 * are driven here on purpose: the unit tests beside `epic-sweep.ts` prove the
 * lane arithmetic and the ones beside `epic-dead-seat-report.ts` prove the
 * wording, but the FAILURE was neither -- it was that a slot held by a dead
 * conversation is indistinguishable, from the beat's chair, from a slot held by a
 * working one. That is only observable where the fold meets the beat.
 *
 * Every case below is run twice, once with the reaper and once without, because
 * the without-run IS the 2026-08-21 incident and a test that only showed the
 * fixed behaviour would not show that anything had been fixed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acknowledgedCardIds, dispatchCountsByCard } from '../shared/epic-log'
import type { EpicLaunchTag, EpicLogEntry } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { Conversation, EpicResult, EpicRunSnapshot } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
import { type BeatDeps, runEpicBeat } from './epic-executor'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { resetPromiseMemory } from './epic-promise'
import { resetArmedEpics } from './epic-registry'
import { type EpicGroup, epicsToWatch } from './epic-sweep'
import type { GitDirt } from './epic-types'
import { NEVER_REAPED, type Reaper, SEAT_SILENCE_MS } from './epic-vitality'

const PROJECT = 'claude://studio/proj'
const EPIC = 'e1'
const DEAD = 'runner-run-delete-verb'
const OTHER = 'epic-digest-shares-run-frontmatter'
const NOW = Date.parse('2026-08-21T16:50:35.000Z')
/** 16:38:35Z -- the real dispatch, twelve minutes before the beat that missed it. */
const DISPATCHED_AT = NOW - 12 * 60_000

const RUN: EpicRunSnapshot = {
  epicId: EPIC,
  project: PROJECT,
  cadence: ['now'],
  status: 'running',
  gen: 6,
  target: 'merged',
  dryGens: 0,
  unlandedWoken: '',
  maxGens: 40,
  maxUsd: 500,
  maxWallClockMinutes: 960,
  spentUsd: 0,
  legBudgetUsd: 0,
  legStartUsd: 0,
  leg: 1,
  // ONE, so a single leaked slot is the whole ceiling and the arithmetic below
  // has exactly one possible explanation.
  concurrency: 1,
  plan: false,
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

function card(slug: string, status: TaskStatus): ProjectTaskMeta {
  return { slug, status, epic: EPIC, title: slug, tags: [], refs: [], created: '', mtime: 1, bodyPreview: '' }
}

/** A seat the registry still calls live: never `ended`, no socket, silent. This
 *  is the shape the incident wore -- `runMaintenancePass` demotes `active` to
 *  `idle` on silence and never goes further. */
function seat(cardId: string, role: EpicLaunchTag['role'], id: string): Conversation {
  return {
    id,
    project: PROJECT,
    status: 'idle',
    lastActivity: DISPATCHED_AT,
    launchConfig: { epic: { epicId: EPIC, role, cardId, gen: 6 } },
  } as unknown as Conversation
}

/** The rule as production wires it: no socket, and silent past the grace. */
const REAPER: Reaper = c => (NOW - c.lastActivity > SEAT_SILENCE_MS ? { silentForMs: NOW - c.lastActivity } : null)

const alwaysLive = () => true
const alwaysProduced = () => true

/** The SEAT lane only -- this file is about a card's concurrency slot, and the
 *  werk-master's own grace is a different number for a different mistake. */
function fold(convs: Conversation[], reaper?: Reaper): EpicGroup {
  const reapers = { seat: reaper ?? NEVER_REAPED, werkMaster: NEVER_REAPED }
  return (
    epicsToWatch(convs, alwaysLive, alwaysProduced, reapers).find(g => g.epicId === EPIC) ??
    ({} as unknown as EpicGroup)
  )
}

let baton: EpicLogEntry[]
let cards: ProjectTaskMeta[]
let spawns: Array<{ epic: Record<string, unknown> }>
let log: string[]
let dirt: GitDirt | undefined
let dirtAsks: number
/** Per-test tweaks to the run artifact -- `concurrency`, mostly. */
let runOver: Partial<EpicRunSnapshot>

const deps = (over: Partial<BeatDeps> = {}) =>
  ({
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => NOW,
    epicSpendUsd: () => 0,
    gitDirt: async () => {
      dirtAsks += 1
      if (!dirt) throw new Error('no fabric')
      return dirt
    },
    ...over,
  }) as unknown as BeatDeps

beforeEach(() => {
  baton = []
  cards = []
  spawns = []
  log = []
  dirtAsks = 0
  runOver = {}
  dirt = { ok: true, dirty: new Set(), known: new Set([`worktree-epic/${EPIC}/${DEAD}`]), merged: new Set() }
  resetPromiseMemory()
  resetArmedEpics()
  configureEpicIo({
    fetchEpicRun: async () => ({
      run: { ...RUN, ...runOver },
      baton,
      acknowledgedCardIds: acknowledgedCardIds(baton),
      dispatchCounts: dispatchCountsByCard(baton),
      lease: null,
    }),
    fetchBoardRead: async () => ({ ok: true, cards }),
    appendBaton: async (_d, _p, _e, entry) => {
      baton.push({
        ts: new Date(NOW).toISOString(),
        kind: entry.kind,
        convId: entry.convId,
        ...(entry.cardId ? { cardId: entry.cardId } : {}),
        body: entry.body,
      })
      return { type: 'epic_result', requestId: 'r', op: 'log_append', ok: true } as EpicResult
    },
    sendEpicOp: async (_d, _p, op) => {
      if (op.op === 'lease') {
        return {
          type: 'epic_result',
          requestId: 'r',
          op: 'lease',
          ok: true,
          lease: { granted: true, convId: 'conv_werk_master', gen: (op.lease?.expectGen ?? 0) + 1, at: '' },
        } as EpicResult
      }
      return { type: 'epic_result', requestId: 'r', op: op.op, ok: true } as EpicResult
    },
    dispatchSpawn: mock(async (req: { epic: Record<string, unknown> }) => {
      spawns.push({ epic: req.epic })
      return { ok: true, conversationId: `conv_spawn_${spawns.length}`, jobId: 'j' }
    }) as never,
    // The promise ledger has no commits to find for these branches and must not
    // be what this file is measuring.
    commitsForBranch: () => null,
  })
})

afterEach(() => {
  resetEpicIo()
})

/** The `completion` the broker wrote for a card, if any. */
const completionFor = (cardId: string) =>
  baton.find(e => e.kind === 'completion' && e.convId === 'broker' && e.cardId === cardId)

const dispatched = () => spawns.map(s => s.epic.cardId)

describe.each([
  ['open', 'a seat that dies before it ever moves its card'],
  ['in-progress', 'a seat that dies after moving its card into the worked lane'],
] as const)('%s: %s', (lane, _title) => {
  beforeEach(() => {
    cards = [card(DEAD, lane), card(OTHER, 'open')]
  })

  /**
   * THE INCIDENT. `runner-run-delete-verb` was dispatched at 16:38:35Z and its
   * conversation was dead by 16:50 -- and the engine wrote NO completion, left
   * the card where it was, and reported a full ceiling. The run does not stall,
   * it degrades, and the degradation is indistinguishable from being busy.
   */
  test('WITHOUT the reaper the slot is held forever and nothing settles', async () => {
    const group = fold([seat(DEAD, 'werk-worker', 'conv_dead')])
    const out = await runEpicBeat(deps(), group)
    expect(group.inFlight).toEqual([DEAD])
    expect(completionFor(DEAD)).toBeUndefined()
    expect(dispatched()).toEqual([])
    // The line gen 7 actually produced. It used to be a bare count -- see below.
    expect(out.note).toContain('still in flight')
  })

  test('WITH the reaper the card settles even though its own lane never moved', async () => {
    const group = fold([seat(DEAD, 'werk-worker', 'conv_dead')], REAPER)
    await runEpicBeat(deps(), group)
    expect(completionFor(DEAD)).toBeDefined()
  })

  /**
   * THE EXPENSIVE HALF. The slot is not held by a lease with a TTL, it is held by
   * the engine's belief that a card is in flight -- so the proof that it came
   * back is that the card behind it goes out.
   */
  test('and the slot returns to the ceiling -- the held-back card is dispatched', async () => {
    // The settle is already acknowledged, so this beat spends itself on work
    // rather than on waking the werk-master for the settle it just found.
    baton = [{ ts: '', kind: 'completion', convId: 'broker', cardId: DEAD, body: 'seen' }]
    const group = fold([seat(DEAD, 'werk-worker', 'conv_dead')], REAPER)
    await runEpicBeat(deps(), group)
    expect(dispatched()).toContain(OTHER)
  })

  /**
   * A BARE COUNT IS UNFALSIFIABLE. "1 still in flight" gave a reader nothing to
   * check, so a slot held by a twelve-minute-old corpse read exactly like a slot
   * held by a working seat. Named, the same sentence becomes a claim anybody can
   * test in one `list_conversations` call.
   */
  test('the in-flight line names the card holding the slot', async () => {
    const out = await runEpicBeat(deps(), fold([seat(DEAD, 'werk-worker', 'conv_dead')]))
    expect(out.note).toContain(DEAD)
  })
})

/**
 * THE OTHER PLACE THE CEILING IS NARRATED, and it is the exact phrase the card
 * was filed against: "HELD BACK by the concurrency ceiling". It only appears on
 * a beat that also moved something, so it needs a run with a slot to spare.
 */
describe('the held-back line names who is holding the slots', () => {
  const THIRD = 'epic-queue-fold-buckets-projects-by-raw-string'

  beforeEach(() => {
    cards = [card(DEAD, 'open'), card(OTHER, 'open'), card(THIRD, 'open')]
  })

  test('a beat that dispatches under a partly-held ceiling names the holder', async () => {
    // Two slots, one of them held by the dead seat: one card goes out, one is
    // held -- which is the only shape that reaches this wording.
    runOver = { concurrency: 2 }
    const out = await runEpicBeat(deps(), fold([seat(DEAD, 'werk-worker', 'conv_dead')]))
    expect(out.note).toContain('held back by the concurrency ceiling')
    expect(out.note).toContain(DEAD)
  })
})

describe('the baton tells a death apart from a completion', () => {
  beforeEach(() => {
    cards = [card(DEAD, 'open')]
  })

  test('a REAPED seat produces a completion entry that says the seat died', async () => {
    await runEpicBeat(deps(), fold([seat(DEAD, 'werk-worker', 'conv_dead')], REAPER))
    expect(completionFor(DEAD)?.body).toContain('SEAT DIED')
  })

  test('a cleanly ended seat produces the ordinary wording, unchanged', async () => {
    const ended = { ...seat(DEAD, 'werk-worker', 'conv_done'), status: 'ended' } as Conversation
    const group = fold([ended], () => null)
    // Ended and holding no socket: dead by the ordinary rule, nothing reaped.
    group.settled = [DEAD]
    group.inFlight = []
    await runEpicBeat(deps(), group)
    expect(completionFor(DEAD)?.body).toContain('every backing conversation has ended')
    expect(completionFor(DEAD)?.body).not.toContain('SEAT DIED')
  })

  test('the death is said in the broker log too, with the conversation id', async () => {
    await runEpicBeat(deps(), fold([seat(DEAD, 'werk-worker', 'conv_dead')], REAPER))
    expect(log.some(l => l.includes('REAPED a dead seat') && l.includes('conv_dea'))).toBe(true)
  })
})

describe("the dead seat's worktree", () => {
  beforeEach(() => {
    cards = [card(DEAD, 'open')]
  })

  /**
   * The seat that vanished on 2026-08-21 had committed its implementation and
   * left 392 lines of finished tests unstaged. It was found only because a human
   * ran `git status` in a worktree for a card the board called unworked.
   */
  test('a dirty branch is named in the baton entry', async () => {
    dirt = {
      ok: true,
      dirty: new Set([`worktree-epic/${EPIC}/${DEAD}`]),
      known: new Set([`worktree-epic/${EPIC}/${DEAD}`]),
      merged: new Set(),
    }
    await runEpicBeat(deps(), fold([seat(DEAD, 'werk-worker', 'conv_dead')], REAPER))
    expect(completionFor(DEAD)?.body).toContain('HAS UNCOMMITTED CHANGES')
    expect(completionFor(DEAD)?.body).toContain(`worktree-epic/${EPIC}/${DEAD}`)
  })

  test('nothing is committed on the dead seat behalf -- the entry says so', async () => {
    dirt = {
      ok: true,
      dirty: new Set([`worktree-epic/${EPIC}/${DEAD}`]),
      known: new Set([`worktree-epic/${EPIC}/${DEAD}`]),
      merged: new Set(),
    }
    await runEpicBeat(deps(), fold([seat(DEAD, 'werk-worker', 'conv_dead')], REAPER))
    expect(completionFor(DEAD)?.body).toContain('nothing has been committed on its behalf')
  })

  test('a git scan that throws is reported as UNKNOWN and never blocks the settle', async () => {
    dirt = undefined
    await runEpicBeat(deps(), fold([seat(DEAD, 'werk-worker', 'conv_dead')], REAPER))
    expect(completionFor(DEAD)?.body).toContain('UNKNOWN')
  })

  test('a broker with no git seam at all still settles, and says it could not look', async () => {
    await runEpicBeat(deps({ gitDirt: undefined }), fold([seat(DEAD, 'werk-worker', 'conv_dead')], REAPER))
    expect(completionFor(DEAD)?.body).toContain('UNKNOWN')
  })

  /** A sentinel round trip with a 15s ceiling, on every beat, for a fact almost
   *  no beat needs. A healthy run must not pay it. */
  test('an ordinary settle never pays for the git scan', async () => {
    const group = fold([seat(DEAD, 'werk-worker', 'conv_dead')], () => null)
    group.settled = [DEAD]
    group.inFlight = []
    await runEpicBeat(deps(), group)
    expect(completionFor(DEAD)).toBeDefined()
    expect(dirtAsks).toBe(0)
  })

  test('a beat that reaps a seat pays for it exactly once', async () => {
    await runEpicBeat(deps(), fold([seat(DEAD, 'werk-worker', 'conv_dead')], REAPER))
    expect(dirtAsks).toBe(1)
  })
})
