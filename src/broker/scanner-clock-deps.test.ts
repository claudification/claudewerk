/**
 * THE WIRING BETWEEN THE CLOCK AND THE TWO SCANNERS.
 *
 * Nothing here is clever, and that is exactly why it needs pinning: a deps
 * builder is a pile of field assignments, every one of which is invisible until
 * an unattended seat lands in the wrong place. The three that would be silently
 * wrong are the ceiling (a backlog of forty tagged cards taking every seat on the
 * box), `projectRoot` (a card file named at a path no seat can open) and the
 * dispatch's own return (a refused spawn counted as work done).
 *
 * IT ALSO PROVES THE PASS REACHES THE REAL SCANNER. `CLOCKED_SCANNERS` holds the
 * only wire between the tick and `refineScanner` / `workOrderScanner`; a test
 * that stubbed the pass would leave that wire exactly as unexercised as it was
 * before this card.
 */

import { describe, expect, test } from 'bun:test'
import { WORK_ORDER_CONCURRENCY } from '../shared/scanner-contracts'
import type { ConversationStore } from './conversation-store'
import { CLOCKED_SCANNERS } from './scanner-clock'
import { buildRefineDeps, buildWorkOrderDeps } from './scanner-clock-deps'
import { DEFAULT_REFINE_CONCURRENCY } from './scanners/refine-scanner'

const PROJECT = 'claude://default/Users/jonas/projects/alpha'

/**
 * A store with NO SENTINEL, which is the interesting empty case: `callBoard`
 * resolves `{ok:false}` rather than throwing, `listBoardCards` turns that into an
 * empty board, and the pass completes idle. A broker whose sentinel is down must
 * sweep to a quiet stop, not crash a timer.
 */
function storeWithNoSentinel(): ConversationStore {
  return {
    getAllConversations: () => [],
    getActiveConversationCount: () => 0,
    hasAnyTranscript: () => false,
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
  } as unknown as ConversationStore
}

describe('buildRefineDeps', () => {
  test('takes its ceiling from the order that declares an appetite, not from a number picked here', () => {
    expect(buildRefineDeps(storeWithNoSentinel(), PROJECT).concurrency).toBe(DEFAULT_REFINE_CONCURRENCY)
  })

  test('names the project URI as the root, the form a seat can actually open', () => {
    const deps = buildRefineDeps(storeWithNoSentinel(), PROJECT)
    expect(deps.project).toBe(PROJECT)
    expect(deps.projectRoot).toBe(PROJECT)
  })

  test('a board nobody can read is an empty board, never a throw', async () => {
    await expect(buildRefineDeps(storeWithNoSentinel(), PROJECT).getCards()).resolves.toEqual([])
  })
})

describe('buildWorkOrderDeps', () => {
  test('holds the work-order ceiling the contract card quotes', () => {
    expect(buildWorkOrderDeps(storeWithNoSentinel(), PROJECT).concurrency).toBe(WORK_ORDER_CONCURRENCY)
  })

  test('the spawn context names the project and leaves the trust at the planner default', () => {
    const { spawnCtx } = buildWorkOrderDeps(storeWithNoSentinel(), PROJECT)
    expect(spawnCtx.project).toBe(PROJECT)
    expect(spawnCtx.projectRoot).toBe(PROJECT)
    // Absent, NOT 'trusted': every WERK order declares `minTrust: 'benevolent'`,
    // and anything lower refuses `WERK-WORKER@1` at plan time.
    expect(spawnCtx.trustLevel).toBeUndefined()
  })

  test('a board nobody can read is an empty board, never a throw', async () => {
    await expect(buildWorkOrderDeps(storeWithNoSentinel(), PROJECT).getCards()).resolves.toEqual([])
  })
})

describe('the clock runs the real scanners', () => {
  for (const scanner of CLOCKED_SCANNERS) {
    test(`${scanner.id}: one pass against a board nobody can read completes quietly`, async () => {
      // No assertion on the outcome beyond "it resolved": `runScan` is
      // self-catching, so the thing being proved is that the wire exists at all
      // and that a dead sentinel does not take the timer down with it.
      await expect(scanner.pass(storeWithNoSentinel(), PROJECT)).resolves.toBeUndefined()
    })
  }
})
