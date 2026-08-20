/**
 * What one beat needs, and what it returns.
 *
 * Its own module because the executor and the action performers both depend on
 * `BeatDeps`, and putting it in either would make the other import from its own
 * collaborator -- the cycle that a type-only file cleanly avoids.
 */

import type { SentinelRpcDeps } from './broker-sentinel-rpc'
import type { SpawnDispatchDeps } from './spawn-dispatch'

export type LogFn = (line: string) => void

export interface BeatDeps extends SentinelRpcDeps {
  /**
   * Everything `dispatchSpawn` needs, passed straight through.
   *
   * TYPED, not `Record<string, unknown>`. It was opaque, and the casts that
   * opacity forced at the call sites are what let the epic SEAT TAG be dropped
   * by the spawn schema unnoticed for the whole life of the feature. A type-only
   * import, so this costs no runtime edge.
   */
  spawnContext: SpawnDispatchDeps
  log: LogFn
  /** Is the project's night window open? ASYNC and consulted ONLY for
   *  cadence=window -- the answer lives in the project's nightshift config, and
   *  a `now` run must not pay a sentinel round trip to be told it does not care. */
  windowOpen: (project: string) => Promise<boolean>
  /** Clock, injected so a beat's recorded time is not a test's wall clock. */
  now: () => number
  /**
   * Total USD these conversations have cost -- the run's spend ledger, folded
   * fresh on every beat.
   *
   * SYNCHRONOUS and injected, like `now`: it is one indexed aggregate over the
   * broker's own store, not a sentinel round trip, and making it async would
   * put an await between the plan and the actions for no gain.
   */
  epicSpendUsd: (conversationIds: readonly string[]) => number
}

export interface BeatOutcome {
  epicId: string
  note: string
  actions: number
  spawned: string[]
  error?: string
}
