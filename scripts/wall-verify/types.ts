/**
 * THE WALL delivery contract -- shared types.
 *
 * The point of this tool: an epic that builds twelve panes in parallel can
 * report "done" on every card while the SURFACE still fails to deliver what was
 * promised. A card says what an agent did; this says what Jonas actually got.
 */

/** A file that must exist, optionally containing a symbol. `glob` searches. */
export interface Probe {
  /** Repo-relative path, or a glob when the exact filename is not fixed. */
  path: string
  /** Must appear somewhere in the matched file(s). Absent = existence only. */
  needle?: string
  /** Shown in the report when this probe is what failed. */
  as?: string
}

export type Verdict =
  /** Card is settled AND every artifact is present. */
  | 'VERIFIED'
  /** Card is settled but an artifact is absent. LOUD -- a false done. */
  | 'MISSING'
  /** Card is not settled yet. Expected; quiet. */
  | 'PENDING'
  /** Feed is absent but a named card is building it. Sequencing, not a failure. */
  | 'BLOCKED'
  /** An upstream feed does not exist, so the promise cannot be kept as written.
   *  LOUDEST -- this is the one Jonas asked to be announced hard. */
  | 'UNDELIVERABLE'

export interface Aspect {
  /** Reference code from the mockup: P1, S2, W1, A7 ... */
  code: string
  /** Board card id that owns it. */
  card: string
  /** One line, in the terms it was promised in. */
  promise: string
  /** What the build must produce for this to be real. */
  artifacts: Probe[]
  /** Upstream data this pane needs. Missing feed = UNDELIVERABLE. */
  feeds?: Probe[]
  /**
   * Card that is building the missing feed, when one exists.
   *
   * This is what keeps the loud channel loud. A dead feed with somebody on it is
   * ordinary sequencing and reports as BLOCKED; a dead feed with NOBODY on it is
   * a promise nobody can keep, and that is the only thing worth shouting. Alarm
   * fatigue would make the shouting useless, so the two are never conflated.
   */
  feedFrom?: string
  /** A test must exist, because a pane with no test is not delivered. */
  test?: Probe
}

export interface AspectResult {
  aspect: Aspect
  verdict: Verdict
  cardStatus: string
  /** Human-readable reasons, one per failed probe. */
  failures: string[]
  /** Probes that passed, for the partial-progress line on PENDING aspects. */
  passed: number
  total: number
}

/**
 * ONLY `done` counts as settled.
 *
 * `in-review` used to be in here and it produced the tool's first false alarm:
 * a card whose work was real, committed, and sitting on an unmerged branch read
 * as a broken promise. An epic targeting `merged` reaches `done` when the work
 * lands, so `done` is the only lane that claims the tree should contain it.
 */
export const SETTLED_LANES = new Set(['done'])
