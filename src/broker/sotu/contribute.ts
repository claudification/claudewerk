/**
 * SOTU contribution chokepoint -- the single write path into a project's queue.
 *
 * Both seams that produce Layer 1 contributions route through `recordContribution`:
 *  - the `scribe_note` wire handler (declared-intent callouts), and
 *  - the deterministic lifecycle floor (broker desk events).
 * Keeping one chokepoint means the queue append + the weighted `pendingContribs`
 * bump (the trigger's busy-ness signal) can never drift apart. NO LLM here -- this
 * is the always-on free floor; the distill engine (Phase 4) drains what lands.
 */

import { appendContribution } from './queue'
import { updateState } from './state'
import type { Contribution } from './types'

/** Trigger weight of a contribution (design: intent=3, lifecycle=2, git-snap=1).
 *  A callout is declared intent (the gold) so it weighs heaviest; a turn-digest is
 *  the baseline floor. The distill trigger (Phase 4) sums these into BURST. */
export function contribWeight(contrib: Contribution): number {
  switch (contrib.kind) {
    case 'callout':
      return 3
    case 'lifecycle':
      return 2
    default:
      // turn_digest + git_scan are the cheap derived/baseline floor.
      return 1
  }
}

/** The result of a recorded contribution: the new weighted pending count (so the
 *  caller can broadcast it without a second state read). */
export interface RecordResult {
  pendingContribs: number
}

/** Append a contribution to the project's queue and bump the weighted pending
 *  counter. The only mutation of a project's SOTU store on the free floor. */
export function recordContribution(slug: string, contrib: Contribution): RecordResult {
  appendContribution(slug, contrib)
  const weight = contribWeight(contrib)
  const next = updateState(slug, s => ({ ...s, pendingContribs: s.pendingContribs + weight }))
  return { pendingContribs: next.pendingContribs }
}
