/**
 * WHEN DOES A DEAD RUN LEAVE THE PANE? -- the burial half of O2.
 *
 * O2 (`wall-runs-liveness-scope`) decided that paused, aborted and expired runs
 * render dimmed and last rather than vanishing, because a run going quiet
 * unnoticed is the failure this fleet actually suffers -- `epic-the-wall` sat
 * `paused` for nine generations and nothing rendered it. That was right, and it
 * left the opposite hole: the tail could only ever grow. A run aborted six weeks
 * ago is not news, and a surface that cannot forget is one you stop reading.
 *
 * SO THERE ARE EXACTLY TWO WAYS OUT, and a live run has neither:
 *
 *  1. ACKNOWLEDGED -- a human pressed CLEAR. The row has done its job the moment
 *     it was seen, so nothing is being hidden; `run.md` and the baton stay on
 *     disk untouched. This is an ACK and not a delete precisely because the
 *     record is what the engine exists to keep.
 *
 *  2. AGED OUT -- nobody pressed anything, and the run has been dead longer than
 *     `RUN_AGE_OUT_MS`. Without this, an unattended fleet's tail is a museum
 *     that only grows, and requiring a click per row makes the pane a chore.
 *
 * ONE DEFINITION, because the pane, the tests and anything that later wants to
 * count what it dropped must agree. A second copy of this arithmetic is how the
 * two-disagreeing-predicates bug that O2 deleted got written in the first place.
 */

/**
 * Seven days. Long enough that a run which died on a Friday is still on the wall
 * on Monday -- the whole point is that a quiet failure survives a weekend --
 * and short enough that the tail is a list of recent deaths rather than an
 * archive. Not configurable on purpose: a knob here is a knob that gets set to
 * zero the first time the pane looks busy, which reinstates O1.
 */
export const RUN_AGE_OUT_MS = 7 * 24 * 60 * 60 * 1000

export interface ClearableRun {
  /** ISO stamp set by the `clear` op, when a human has seen this run end. */
  acknowledgedAt?: string | null
  /** ISO of the last thing that happened to the run -- `updated` on the artifact,
   *  or the last beat for a feed that has no artifact to read. */
  deadSince?: string | null
}

/** Milliseconds, or null when the stamp is missing or unparseable. A card
 *  somebody hand-edited must never age out a run by accident. */
function stampMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Has this DEAD run left the pane? Callers ask liveness first -- a live run is
 * never cleared, whatever its stamps say, and this function does not re-litigate
 * that.
 */
export function runCleared(run: ClearableRun, nowMs: number): boolean {
  if (run.acknowledgedAt) return true
  const since = stampMs(run.deadSince)
  return since !== null && nowMs - since > RUN_AGE_OUT_MS
}

/** WHY it went, for the one line that reports what a pane dropped. Never a bare
 *  count: "3 hidden" with no reason is the shape O3 was rejected for. */
export function clearedReason(run: ClearableRun, nowMs: number): 'acknowledged' | 'aged-out' | null {
  if (run.acknowledgedAt) return 'acknowledged'
  return runCleared(run, nowMs) ? 'aged-out' : null
}
