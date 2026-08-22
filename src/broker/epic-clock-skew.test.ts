/**
 * TWO CLOCKS, END TO END -- the lease is stamped by the SENTINEL and its age is
 * judged by the BROKER.
 *
 * `epic-beat.test.ts` pins the arithmetic (`clockSkewMs` in, corrected age out).
 * This pins the WIRING, which is the half a pure-fold test cannot reach: the
 * sentinel has to SAY what time it thinks it is (`EpicResult.clockMs`), the fold
 * has to carry it (`EpicRunView.sentinelClockMs`), and the executor has to turn it
 * into an offset before `werkMasterGate` sees a duration. A double for
 * `fetchEpicRun` would happily hand back a number no sentinel ever computes.
 *
 * THE SCENARIO IS THE ONE THIS BOX PRODUCES. The sentinel writes every `_at` on
 * the laptop; the broker runs in a container in a VM, deploys separately, and its
 * clock jumps when the host sleeps. Believing it is twenty minutes later than the
 * sentinel makes every live werk-master read as instantly past `LEASE_STALE_MS`,
 * so the beat dispatches underneath a supervisor that is mid-turn -- on every
 * tick, for the whole life of the skew. That is the exact failure the TTL exists
 * to prevent, produced by the TTL's own arithmetic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleEpicOp } from '../sentinel/epic-handlers'
import { LEASE_STALE_MS } from '../shared/epic-lease'
import { cardPath } from '../shared/project-paths'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicBatonQuery, EpicResult } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
import { toEpicRunView } from './epic-broker-rpc'
import { type BeatDeps, runEpicBeat } from './epic-executor'
import { configureEpicIo, epicIo, resetEpicIo } from './epic-io'
import { resetPromiseMemory } from './epic-promise'
import type { EpicGroup } from './epic-sweep'

const PROJECT = 'claude://studio/proj'
/** The clock the SENTINEL keeps -- every `_at` in this file is stamped with it. */
const SENTINEL_NOW = Date.parse('2026-08-22T08:00:00.000Z')
/** How far ahead the broker's own clock has drifted. */
const SKEW = 20 * 60_000

let root = ''
let log: string[]
let spawns: string[]
let cards: ProjectTaskMeta[]
/** The BROKER's clock, which is the whole point: it is not `SENTINEL_NOW`. */
let nowMs: number

function card(slug: string, status: TaskStatus, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return { slug, status, title: slug, tags: [], refs: [], created: '', mtime: 1, bodyPreview: '', ...over }
}

/** The epic as the engine sees it: a werk-master at the keyboard, its conversation
 *  live, one card ready underneath. */
function group(): EpicGroup {
  return {
    epicId: 'e1',
    project: PROJECT,
    inFlight: [],
    inVerify: [],
    werkMasterAlive: true,
    liveWerkMasters: ['conv_master'],
    abandonedWerkMasters: [],
    settled: [],
    failedLegs: [],
    abandonedSeats: [],
    unspawnable: [],
    convIds: ['conv_master'],
    maxGenSeen: 3,
  } as unknown as EpicGroup
}

const deps = () =>
  ({
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => nowMs,
    epicSpendUsd: () => 0,
  }) as unknown as BeatDeps

/** The REAL sentinel handler, on the SENTINEL's clock. */
const sentinel = (op: 'get' | 'log_append' | 'start' | 'patch', extra: Record<string, unknown> = {}) =>
  handleEpicOp(
    root,
    { type: 'epic_op', requestId: 'r', projectRoot: root, op, epicId: 'e1', ...extra } as never,
    SENTINEL_NOW,
  )

/** Rewrite the epic card's lease timestamp, in the SENTINEL's own time. */
function leaseTakenAgoBySentinel(ms: number): void {
  const file = cardPath(root, 'e1', false)
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(/overseer_at: .*/, `overseer_at: ${new Date(SENTINEL_NOW - ms).toISOString()}`),
    'utf8',
  )
}

beforeEach(() => {
  log = []
  spawns = []
  nowMs = SENTINEL_NOW + SKEW
  resetPromiseMemory()

  root = mkdtempSync(join(tmpdir(), 'epic-skew-'))
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
  writeFileSync(
    cardPath(root, 'e1', false),
    [
      '---',
      'title: The epic',
      'status: open',
      'tags: [epic]',
      'overseer: conv_master',
      'overseer_gen: 3',
      // ONE MINUTE OLD by the clock that wrote it. Uncorrected, the broker reads
      // twenty-one.
      `overseer_at: ${new Date(SENTINEL_NOW - 60_000).toISOString()}`,
      '---',
      '',
      'Body.',
      '',
    ].join('\n'),
    'utf8',
  )
  sentinel('start', { start: { plan: false } })
  sentinel('patch', { patch: { status: 'running' } })

  // One card ready, so a beat that stripped the werk-master of its grip visibly
  // dispatches under it rather than merely logging something.
  cards = [card('e1', 'open', { tags: ['epic'] }), card('t1', 'open', { epic: 'e1' })]

  configureEpicIo({
    fetchEpicRun: async (_d, _p, epicId, baton?: EpicBatonQuery) =>
      toEpicRunView(sentinel('get', { ...(baton ? { baton } : {}) }) as EpicResult & { epicId: typeof epicId }),
    fetchBoardCards: async () => cards,
    appendBaton: async (_d, _p, _e, entry) => sentinel('log_append', { logAppend: entry }) as EpicResult,
    sendEpicOp: async (_d, _p, op) => ({ type: 'epic_result', requestId: 'r', op: op.op, ok: true }) as EpicResult,
    dispatchSpawn: mock(async (req: { name: string }) => {
      spawns.push(req.name)
      return { ok: true, conversationId: `conv_${spawns.length}`, jobId: 'j' }
    }) as never,
  })
})

afterEach(() => {
  resetEpicIo()
  rmSync(root, { recursive: true, force: true })
})

describe('clock skew between broker and sentinel, against the real sentinel seam', () => {
  test('the sentinel states its own clock on `get`, and the broker fold carries it', async () => {
    const view = await epicIo().fetchEpicRun(deps(), PROJECT, 'e1')
    expect(view.sentinelClockMs).toBe(SENTINEL_NOW)
  })

  test('a werk-master mid-turn KEEPS the beat -- nothing dispatches underneath it', async () => {
    const out = await runEpicBeat(deps(), group())
    expect(spawns).toHaveLength(0)
    expect(out.actions).toBe(0)
    expect(out.note).toContain('WORKING')
  })

  test('and the skew is said out loud, because a correction nobody sees is one nobody can size', async () => {
    await runEpicBeat(deps(), group())
    expect(log.join('\n')).toContain('CLOCK SKEW')
    expect(log.join('\n')).toContain('AHEAD OF')
  })

  /** Clocks that agree say nothing at all: a line on every beat of every healthy
   *  run is a line nobody reads on the run where it matters. */
  test('clocks that agree produce no skew line', async () => {
    nowMs = SENTINEL_NOW
    await runEpicBeat(deps(), group())
    expect(log.join('\n')).not.toContain('CLOCK SKEW')
  })

  /**
   * THE CORRECTION MUST NOT BECOME A SHELTER. The TTL exists because a werk-master
   * blocked in a Bash call holds its socket, emits nothing, cannot be reaped, and
   * froze a run for the life of the broker on 2026-08-20. A grip that is old on
   * the sentinel's OWN clock still ages out, skew or no skew.
   */
  test('a grip that really is past the TTL still loses the beat', async () => {
    leaseTakenAgoBySentinel(LEASE_STALE_MS + 60_000)
    const out = await runEpicBeat(deps(), group())
    expect(out.note).toContain('STALE')
    expect(spawns).toHaveLength(1)
  })
})
