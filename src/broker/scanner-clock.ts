/**
 * THE MISSING CLOCK -- the standing invocation `refine` and `work-order` never
 * had.
 *
 * Both scanners were built, tested, and imported by NOTHING outside their own
 * test files: no clock, no route, no registry. That is precisely the "enabled,
 * last ran never" failure their own headers mock -- the one that killed
 * nightshift (0 runs since June), scheduled tasks (0 ever) and quests (0 ever).
 * Ticking either checkbox in Project Settings did nothing at all.
 *
 * WHAT A CLOCK OWNS, and it is exactly what the scanner contract says a scanner
 * must not:
 *
 *   cadence      one interval per scanner, from `scanner-contracts.ts`
 *   reentrancy   one tick at a time, per scanner (`werk-tick.ts`)
 *   quarantine   nothing dispatches while agent hosts are still reconnecting
 *   the gate     the per-project opt-in, checked before a board is even read
 *   the stamp    `scannersLastRun` advanced on a COMPLETED pass
 *
 * ONE TICK PER SCANNER, NOT ONE FOR BOTH. The guard in `startWerkTick` is
 * per-tick, so a shared one would let a slow refine pass hold back every
 * work-order pass behind it -- and the two have nothing to say to each other.
 * Separate ticks also keep the cadence in the contract honest: each row of the
 * panel states an interval that one timer actually keeps.
 *
 * SEQUENTIAL ACROSS PROJECTS, deliberately. Each pass is sentinel round trips
 * plus, at the end, spawns. Firing every opted-in project's pass concurrently
 * would put N board RPCs on one sentinel at once and let N ceilings that were
 * each checked separately add up to something nobody authorised.
 */

import { SCANNER_TICK_INTERVAL_MS } from '../shared/scanner-contracts'
import type { ScannerId } from '../shared/scanner-ids'
import type { ConversationStore } from './conversation-store'
import { listProjects } from './project-store'
import { buildRefineDeps, buildWorkOrderDeps } from './scanner-clock-deps'
import { buildScannerOptIn, buildSkipLog, gateProjects, type ScannerOptIn, type SkipLog } from './scanner-gate'
import { refineScanner } from './scanners/refine-scanner'
import { runScan } from './scanners/scanner'
import { workOrderScanner } from './scanners/work-order-scanner'
import { startWerkTick, type WerkTick } from './werk-tick'

/**
 * One clocked scanner: how often, and what one pass over ONE project is.
 *
 * `pass` returns nothing on purpose. `runScan` is self-catching and already logs
 * the two things worth shouting about (a crash, an unaccounted unit), and the
 * scanners log their own per-unit lines -- so a return value here would only
 * tempt the clock into forming a second opinion about a pass it did not run.
 */
export interface ClockedScanner {
  id: ScannerId
  intervalMs: number
  pass: (store: ConversationStore, project: string) => Promise<void>
}

/**
 * THE TWO SCANNERS THIS CLOCK DRIVES, and why the other three are absent.
 *
 * `epics` keeps its own loop (`epic-sweep-loop.ts`): `beatOneEpic` deliberately
 * shares that loop's reentrancy guard while running DIFFERENT work, which this
 * primitive has no way to express. `nightshift` is invoked when a night run
 * opens, which is a window and not an interval -- its gate and stamp live in
 * `nightshift-orchestrator.ts`. `morning-report` is fired by a schedule and has
 * no implementation yet.
 */
export const CLOCKED_SCANNERS: readonly ClockedScanner[] = [
  {
    id: 'refine',
    intervalMs: SCANNER_TICK_INTERVAL_MS,
    pass: async (store, project) => {
      await runScan(refineScanner, buildRefineDeps(store, project))
    },
  },
  {
    id: 'work-order',
    intervalMs: SCANNER_TICK_INTERVAL_MS,
    pass: async (store, project) => {
      await runScan(workOrderScanner, buildWorkOrderDeps(store, project))
    },
  },
]

/** Everything one tick does, injected -- so the whole pass is exercised without
 *  a settings store, a project registry or a sentinel. */
export interface ClockDeps {
  /** Every project the broker knows, opted in or not. The DENOMINATOR of the
   *  skip line: a project absent from here is a project nobody can be told about. */
  knownProjects: () => string[]
  optIn: ScannerOptIn
  skipLog: SkipLog
  log: (line: string) => void
  now: () => number
}

/**
 * ONE PASS OVER EVERY OPTED-IN PROJECT, then the stamps.
 *
 * THE STAMP IS PER PROJECT AND LANDS AFTER THAT PROJECT'S PASS, not after the
 * whole sweep. A pass that threw for project A must not stamp A -- but it must
 * still stamp B, whose pass completed. `runScan` swallows everything a scanner
 * can throw, so in practice the loop below always reaches every project; the
 * try/finally is what keeps that true if a DEP throws (a board RPC that rejects
 * rather than resolving `{ok:false}`) instead of the scan.
 *
 * "COMPLETED" MEANS THE PASS HAPPENED, not that it dispatched anything. A pass
 * over a project with an empty board is exactly the pass whose stamp matters:
 * it is what makes "enabled, last ran never" mean the loop is dead rather than
 * the board being quiet -- the distinction nightshift (0 runs since June) could
 * not make about itself.
 */
export async function runClockedScanner(
  scanner: ClockedScanner,
  store: ConversationStore,
  deps: ClockDeps,
): Promise<void> {
  const { run } = gateProjects(deps.knownProjects(), deps.optIn, deps.skipLog)
  for (const project of run) {
    try {
      await scanner.pass(store, project)
    } catch (err) {
      // A dep that rejects rather than resolving. Logged and NOT stamped: the
      // pass did not complete, and a stamp for it would be the amber column
      // lying in the one direction nobody checks.
      deps.log(
        `[scanner:${scanner.id}] pass FAILED for ${project} -- not stamped: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    deps.optIn.stamp(project, deps.now())
  }
}

/** The real deps for one scanner: settings-backed gate, project registry, console.
 *  Module-internal -- `startScannerClock` is the only door, and a test drives
 *  `runClockedScanner` with deps of its own rather than reaching for these. */
function buildClockDeps(id: ScannerId): ClockDeps {
  const log = (line: string) => console.log(line)
  return {
    knownProjects: () => listProjects().map(p => p.project_uri),
    optIn: buildScannerOptIn(id),
    skipLog: buildSkipLog(id, log),
    log,
    now: Date.now,
  }
}

/**
 * Start every clocked scanner. Returns the stop function (tests + clean shutdown).
 *
 * Inert out of the box, and that is the whole design: with no project opting in,
 * every tick gates its way down to an empty list, spends nothing, and says once
 * which box to tick.
 */
export function startScannerClock(store: ConversationStore): () => void {
  const ticks: WerkTick[] = CLOCKED_SCANNERS.map(scanner => {
    const deps = buildClockDeps(scanner.id)
    const tick = startWerkTick({
      tag: `[scanner:${scanner.id}]`,
      intervalMs: scanner.intervalMs,
      run: () => runClockedScanner(scanner, store, deps),
      log: deps.log,
      now: deps.now,
    })
    deps.log(
      `[scanner:${scanner.id}] started (${Math.round(scanner.intervalMs / 1000)}s) -- ` +
        'off by default; tick it per project in Project Settings > Scanners',
    )
    return tick
  })
  return () => {
    for (const tick of ticks) tick.stop()
  }
}
