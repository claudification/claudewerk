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
  /**
   * WHICH BRANCHES IN THIS PROJECT HAVE UNCOMMITTED WORK RIGHT NOW.
   *
   * Only ever consulted when a seat has just been REAPED (`epic-vitality.ts`),
   * because it is a sentinel round trip with a 15s ceiling and a healthy
   * beat must not pay for it. What it buys is the second half of the 2026-08-21
   * finding: the seat that vanished had committed its implementation and left 392
   * lines of finished tests UNSTAGED in its worktree, and the only reason anyone
   * ever saw them is that a human ran `git status` in a worktree for a card the
   * board called unworked. The engine's job is to make that dirt VISIBLE -- never
   * to commit it, which is a judgement about whether work is finished and belongs
   * to the werk-master.
   *
   * OPTIONAL, and absent is reported as UNKNOWN rather than as clean. "We could
   * not look" and "there is nothing there" are the two answers it would be worst
   * to conflate, and a beat with no sentinel would otherwise quietly certify a
   * worktree it never opened.
   */
  gitDirt?: (project: string) => Promise<GitDirt>
}

/**
 * The answer to "what is uncommitted in this project", or the reason there is no
 * answer.
 *
 * TWO SETS, not one. `dirty` is the branches with uncommitted changes; `known` is
 * every branch the scan SAW. Without the second, a branch that was never scanned
 * -- because the worktree was removed, or the card's seat never made one -- is
 * indistinguishable from a branch that was scanned and found clean, and the
 * engine would report "clean" about a directory nothing has looked at.
 */
export type GitDirt =
  | { ok: true; dirty: ReadonlySet<string>; known: ReadonlySet<string> }
  | { ok: false; error: string }

export interface BeatOutcome {
  epicId: string
  note: string
  actions: number
  spawned: string[]
  error?: string
}
