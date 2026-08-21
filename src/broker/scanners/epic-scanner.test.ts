import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Conversation, EpicResult, EpicRunSnapshot } from '../../shared/protocol'
import { configureEpicIo, resetEpicIo } from '../epic-io'
import { noteArmedEpic, resetArmedEpics } from '../epic-registry'
import type { SweepDeps } from '../epic-sweep-loop'
import { epicScanner } from './epic-scanner'
import { runScan } from './scanner'

let log: string[]
let convs: Conversation[]
let run: EpicRunSnapshot | null

function conv(epicId: string, cardId: string): Conversation {
  return {
    id: `conv_${epicId}_${cardId}`,
    project: `claude://s/${epicId}`,
    status: 'ended',
    launchConfig: { epic: { epicId, role: 'implementer', gen: 1, cardId } },
  } as unknown as Conversation
}

const deps = (): SweepDeps =>
  ({
    getAllConversations: () => convs,
    isLive: () => false,
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    epicSpendUsd: () => 0,
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => 0,
  }) as unknown as SweepDeps

beforeEach(() => {
  log = []
  convs = []
  run = null
  resetArmedEpics()
  configureEpicIo({
    fetchEpicRun: async () => ({
      run,
      baton: [],
      acknowledgedCardIds: [],
      dispatchCounts: {},
      lease: null,
      error: 'no run in this test',
    }),
    fetchBoardCards: async () => [],
    appendBaton: async () => ({ type: 'epic_result', requestId: 'r', op: 'log_append', ok: true }) as EpicResult,
    sendEpicOp: async () => ({ type: 'epic_result', requestId: 'r', op: 'get', ok: true }) as EpicResult,
  })
})

afterEach(() => {
  resetEpicIo()
  resetArmedEpics()
})

describe('what the epic scanner selects', () => {
  test('every epic with conversations, one entry each and not one per conversation', async () => {
    convs = [conv('e1', 't1'), conv('e1', 't2'), conv('e2', 'x1')]
    const report = await runScan(epicScanner, deps())
    expect([...report.selected].sort()).toEqual(['e1', 'e2'])
  })

  test('an ARMED run with no conversations yet is selected too', async () => {
    noteArmedEpic('claude://s/e1', 'e1')
    const report = await runScan(epicScanner, deps())
    expect(report.selected).toEqual(['e1'])
  })

  test('nothing to sweep says so, rather than returning a blank shrug', async () => {
    const report = await runScan(epicScanner, deps())
    expect(report.selected).toEqual([])
    expect(report.idleReason).toBe('no epic-tagged conversations and no armed runs')
  })
})

describe('the named refusals', () => {
  test("a beat with nothing to do is refused as `idle`, carrying the beat's own note", async () => {
    convs = [conv('e1', 't1')]
    const report = await runScan(epicScanner, deps())
    expect(report.acted).toEqual([])
    expect(report.refused).toHaveLength(1)
    expect(report.refused[0].unit).toBe('e1')
    expect(report.refused[0].bucket).toBe('idle')
    expect(report.refused[0].detail).toContain('no run artifact')
  })

  test('an INERT run is refused as `idle` with the status in the detail', async () => {
    convs = [conv('e1', 't1')]
    run = { status: 'paused', gen: 3 } as unknown as EpicRunSnapshot
    const report = await runScan(epicScanner, deps())
    expect(report.refused[0]).toMatchObject({ unit: 'e1', bucket: 'idle' })
    expect(report.refused[0].detail).toContain('paused')
  })

  test('a beat that THROWS is refused as `beat-crashed`, and the other epics still get beaten', async () => {
    convs = [conv('e1', 't1'), conv('e2', 'x1')]
    configureEpicIo({
      fetchEpicRun: async (_d, project) => {
        if (project === 'claude://s/e1') throw new Error('sentinel exploded')
        return { run: null, baton: [], acknowledgedCardIds: [], dispatchCounts: {}, lease: null }
      },
    })
    const report = await runScan(epicScanner, deps())

    expect(report.refused.find(r => r.unit === 'e1')).toEqual({
      unit: 'e1',
      bucket: 'beat-crashed',
      detail: 'sentinel exploded',
    })
    expect(report.refused.find(r => r.unit === 'e2')?.bucket).toBe('idle')
    expect(log.join('\n')).toContain('[epic-sweep] beat crashed for e1: sentinel exploded')
  })
})

/**
 * The contract's whole point, asserted against the one scanner that has actually
 * run: a pass may not look at an epic and then say nothing about it.
 */
describe('the accounting holds for every branch', () => {
  test('an idle pass accounts for every epic it selected', async () => {
    convs = [conv('e1', 't1'), conv('e2', 'x1')]
    noteArmedEpic('claude://s/e3', 'e3')
    const report = await runScan(epicScanner, deps())
    expect(report.selected).toHaveLength(3)
    expect(report.unaccounted).toEqual([])
    expect(report.acted.length + report.refused.length).toBe(3)
  })

  test('a beat that took an action lands in `acted`, not in a refusal bucket', async () => {
    // A settled card the baton has never acknowledged -- the standing question
    // the wake is built on, and the cheapest beat that actually does something.
    convs = [conv('e1', 't1')]
    run = {
      status: 'running',
      gen: 1,
      maxGens: 8,
      concurrency: 3,
      cadence: 'always',
      epicId: 'e1',
      project: 'claude://s/e1',
    } as unknown as EpicRunSnapshot
    const report = await runScan(epicScanner, deps())

    expect(report.acted).toEqual(['e1'])
    expect(report.refused).toEqual([])
    expect(report.idleReason).toBeUndefined()
    expect(report.unaccounted).toEqual([])
  })

  test('a crashing pass accounts for it too', async () => {
    convs = [conv('e1', 't1')]
    configureEpicIo({
      fetchEpicRun: async () => {
        throw new Error('boom')
      },
    })
    const report = await runScan(epicScanner, deps())
    expect(report.unaccounted).toEqual([])
  })
})
