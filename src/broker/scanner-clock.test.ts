/**
 * THE CLOCK `refine` AND `work-order` NEVER HAD.
 *
 * The failure this file pins is not a wrong answer, it is NO answer: both
 * scanners were built, tested and imported by nothing outside their own tests,
 * so ticking either box in Project Settings did nothing at all and the row said
 * `last ran never` forever. Every case below is one of the four things a caller
 * owes the fabric -- the gate, the spend order, the stamp, and the reentrancy the
 * cadence brings with it.
 */

import { describe, expect, test } from 'bun:test'
import { SCANNER_CONTRACTS, SCANNER_TICK_INTERVAL_MS } from '../shared/scanner-contracts'
import type { ConversationStore } from './conversation-store'
import { CLOCKED_SCANNERS, type ClockDeps, type ClockedScanner, runClockedScanner } from './scanner-clock'
import { buildSkipLog, type ScannerOptIn } from './scanner-gate'

const A = 'claude://default/Users/jonas/projects/alpha'
const B = 'claude://default/Users/jonas/projects/beta'

const STORE = {} as unknown as ConversationStore

/** Everything one tick touches, recorded. */
interface Harness {
  deps: ClockDeps
  swept: string[]
  stamped: Array<{ project: string; at: number }>
  lines: string[]
}

function harness(enabled: readonly string[], known: readonly string[] = [A, B]): Harness {
  const stamped: Array<{ project: string; at: number }> = []
  const lines: string[] = []
  const optIn: ScannerOptIn = {
    projects: () => [...enabled],
    enabled: p => enabled.includes(p),
    stamp: (project, at) => stamped.push({ project, at }),
  }
  let clock = 1000
  return {
    swept: [],
    stamped,
    lines,
    deps: {
      knownProjects: () => [...known],
      optIn,
      skipLog: buildSkipLog('refine', l => lines.push(l)),
      log: l => lines.push(l),
      // Moves every read, so a stamp can be told apart from the one before it.
      now: () => (clock += 1),
    },
  }
}

/** A scanner whose whole pass is "write down which project you were given". */
function recorder(swept: string[], onPass?: (project: string) => void): ClockedScanner {
  return {
    id: 'refine',
    intervalMs: SCANNER_TICK_INTERVAL_MS,
    pass: async (_store, project) => {
      swept.push(project)
      onPass?.(project)
    },
  }
}

describe('runClockedScanner', () => {
  test('sweeps every opted-in project and stamps each one', async () => {
    const h = harness([A, B])
    await runClockedScanner(recorder(h.swept), STORE, h.deps)
    expect(h.swept).toEqual([A, B])
    expect(h.stamped.map(s => s.project)).toEqual([A, B])
  })

  // THE WHOLE POINT OF A DEFAULT-DENY OPT-IN: an opted-out project must never
  // reach the scanner, because reaching it is what costs a board RPC and then a
  // seat. A gate that filtered results after the fact would be no gate at all.
  test('a project with the box off is never handed to the scanner, and never stamped', async () => {
    const h = harness([A])
    await runClockedScanner(recorder(h.swept), STORE, h.deps)
    expect(h.swept).toEqual([A])
    expect(h.stamped.map(s => s.project)).toEqual([A])
  })

  test('with nothing opted in, nothing is swept and nothing is stamped', async () => {
    const h = harness([])
    await runClockedScanner(recorder(h.swept), STORE, h.deps)
    expect(h.swept).toEqual([])
    expect(h.stamped).toEqual([])
  })

  test('the skip names the project and the scanner, so the log says which box to tick', async () => {
    const h = harness([A])
    await runClockedScanner(recorder(h.swept), STORE, h.deps)
    const skip = h.lines.find(l => l.includes('skipped'))
    expect(skip).toBeDefined()
    expect(skip).toContain('[scanner:refine]')
    expect(skip).toContain(B)
    expect(skip).toContain('Project Settings > Scanners')
  })

  // "Completed" means the pass HAPPENED, not that it dispatched. A project with
  // an empty board is exactly the one whose stamp matters: without it, "enabled,
  // last ran never" cannot tell a dead loop from a quiet board.
  test('a pass that did nothing at all still stamps', async () => {
    const h = harness([A])
    await runClockedScanner({ id: 'refine', intervalMs: 1, pass: async () => {} }, STORE, h.deps)
    expect(h.stamped.map(s => s.project)).toEqual([A])
  })

  test('a pass that THREW is not stamped, and does not stop the projects after it', async () => {
    const h = harness([A, B])
    const scanner = recorder(h.swept, project => {
      if (project === A) throw new Error('board exploded')
    })
    await runClockedScanner(scanner, STORE, h.deps)
    expect(h.swept).toEqual([A, B])
    expect(h.stamped.map(s => s.project)).toEqual([B])
    expect(h.lines.some(l => l.includes('pass FAILED') && l.includes(A))).toBe(true)
  })

  /**
   * THE DRAIN RUNS FIRST. A card whose seat landed its work must lose the tag
   * BEFORE this tick's selection reads the board, or the scan spends a second
   * seat on a card that is already done with.
   */
  test('a tick is drain THEN pass, per project', async () => {
    const h = harness([A, B])
    const order: string[] = []
    await runClockedScanner(
      {
        id: 'refine',
        intervalMs: 1,
        pass: async (_s, project) => {
          order.push(`pass:${project}`)
        },
        drain: async (_s, project) => {
          order.push(`drain:${project}`)
        },
      },
      STORE,
      h.deps,
    )
    expect(order).toEqual([`drain:${A}`, `pass:${A}`, `drain:${B}`, `pass:${B}`])
  })

  /** A tick whose queue maintenance blew up did not complete, whatever the scan
   *  afterwards managed -- and the scan does not run at all, because it would be
   *  selecting from a queue nobody drained. */
  test('a drain that THREW skips the pass, is not stamped, and says which half failed', async () => {
    const h = harness([A])
    await runClockedScanner(
      {
        id: 'refine',
        intervalMs: 1,
        pass: async (_s, project) => {
          h.swept.push(project)
        },
        drain: async () => {
          throw new Error('board refused the write')
        },
      },
      STORE,
      h.deps,
    )
    expect(h.swept).toEqual([])
    expect(h.stamped).toEqual([])
    expect(h.lines.some(l => l.includes('drain FAILED') && l.includes(A))).toBe(true)
  })

  test('a scanner with no drain still ticks', async () => {
    const h = harness([A])
    await runClockedScanner(recorder(h.swept), STORE, h.deps)
    expect(h.swept).toEqual([A])
    expect(h.stamped.map(s => s.project)).toEqual([A])
  })

  test('the stamp is read from the injected clock, not the wall clock', async () => {
    const h = harness([A])
    await runClockedScanner(recorder(h.swept), STORE, h.deps)
    expect(h.stamped[0]?.at).toBeLessThan(2000)
  })

  test('projects are swept one at a time, never all at once', async () => {
    const h = harness([A, B])
    let inFlight = 0
    let overlapped = false
    const scanner: ClockedScanner = {
      id: 'refine',
      intervalMs: 1,
      pass: async () => {
        inFlight += 1
        if (inFlight > 1) overlapped = true
        await Promise.resolve()
        inFlight -= 1
      },
    }
    await runClockedScanner(scanner, STORE, h.deps)
    expect(overlapped).toBe(false)
  })
})

describe('CLOCKED_SCANNERS', () => {
  test('covers exactly the two scanners that had no caller', () => {
    expect(CLOCKED_SCANNERS.map(s => s.id)).toEqual(['refine', 'work-order'])
  })

  // A panel that invents its own interval is the drift that makes a settings
  // screen worth ignoring -- so the row and the timer read one number.
  test('each one runs at the cadence its contract card advertises', () => {
    for (const scanner of CLOCKED_SCANNERS) {
      expect(SCANNER_CONTRACTS[scanner.id].cadence).toBe(`every ${Math.round(scanner.intervalMs / 1000)}s`)
    }
  })

  /**
   * `refine` DRAINS ITS TAG AND `work-order` DOES NOT, and the asymmetry is the
   * design. `needs-refine` is a one-shot queue entry; `ready` is a STANDING
   * authorisation ("unattended work, whenever"), so clearing it on settle would
   * mean a bounced card could never be picked up again without a human re-tagging
   * it by hand.
   */
  test('refine carries a drain and work-order deliberately does not', () => {
    const byId = new Map(CLOCKED_SCANNERS.map(s => [s.id, s]))
    expect(byId.get('refine')?.drain).toBeDefined()
    expect(byId.get('work-order')?.drain).toBeUndefined()
  })

  test('a scanner with a clock no longer says "no caller yet"', () => {
    for (const scanner of CLOCKED_SCANNERS) {
      expect(SCANNER_CONTRACTS[scanner.id].cadence).toBeDefined()
      expect(SCANNER_CONTRACTS[scanner.id].built).toBe(true)
    }
  })
})
