/**
 * What one beat needs, and what it returns.
 *
 * Its own module because the executor and the action performers both depend on
 * `BeatDeps`, and putting it in either would make the other import from its own
 * collaborator -- the cycle that a type-only file cleanly avoids.
 */

import type { SentinelRpcDeps } from './broker-sentinel-rpc'

export type LogFn = (line: string) => void

export interface BeatDeps extends SentinelRpcDeps {
  /** Everything `dispatchSpawn` needs, passed straight through. */
  spawnContext: Record<string, unknown>
  log: LogFn
  /** Is the project's night window open? ASYNC and consulted ONLY for
   *  cadence=window -- the answer lives in the project's nightshift config, and
   *  a `now` run must not pay a sentinel round trip to be told it does not care. */
  windowOpen: (project: string) => Promise<boolean>
  /** Clock, injected so a beat's recorded time is not a test's wall clock. */
  now: () => number
}

export interface BeatOutcome {
  epicId: string
  note: string
  actions: number
  spawned: string[]
  error?: string
}
