/**
 * HEADROOM IS A RESOURCE -- the third one, and the only one that cannot be bought.
 *
 * Seats are admission-controlled by the concurrency ceiling and dollars by
 * `maxUsd`. Plan headroom was not controlled at all, and it is the one that fails
 * WORST: a seat dispatched into a rate-limited profile burns the slot, produces
 * nothing, and settles the card as if it had done the job. Not a loud failure --
 * silent false progress, the same family as "belief is not a lease".
 *
 * WHAT THIS MODULE IS NOT. It does not measure anything and it does not choose a
 * profile. `src/sentinel/usage-headroom.ts` derives the windows (with the
 * hard-won 429 carry-forward, the longer 401 window and post-reset decay), and
 * `selection.ts` ranks profiles by them. This is only the REFUSAL those two never
 * had a caller for -- `pickBalanced` always returns a best candidate, so with
 * every profile gated it picks the least-throttled one and spawns anyway. That is
 * correct for a human asking for a conversation and wrong for an unattended run,
 * which has no deadline and every reason to wait twenty minutes.
 *
 * THE REFUSAL BELONGS TO THE ENGINE, NOT THE PICKER. Do not change the picker's
 * all-gated fallback: an interactive spawn still wants a profile back.
 */

import { GATE_FIVE_HOUR_PCT } from '../sentinel/selection'
import { formatDuration } from '../shared/format-duration'
import type { ProfileUsageSnapshot } from '../shared/protocol'

/**
 * One profile's 5h window, flattened to what a refusal needs.
 *
 * The 5h window ONLY. The 7d window is a soft preference in `selection.ts` and
 * stays one here: a weekly budget at 90% still serves work today, and refusing on
 * it would hold a run for days rather than minutes.
 */
export interface ProfileHeadroom {
  profile: string
  fiveHourUsedPercent: number
  /** ms until the 5h window rolls over. The countdown a held beat reports. */
  msUntilFiveHourReset: number
  /** A carried-forward or failed reading. Never refuses -- see `headroomVerdict`. */
  stale: boolean
}

/** Mirrors `QueueVerdict`: the beat is handed a verdict, not the evidence. */
export interface HeadroomVerdict {
  blocked: boolean
  /** Empty when not blocked. Carries the binding profile and its countdown. */
  reason: string
}

const CLEAR: HeadroomVerdict = { blocked: false, reason: '' }

/**
 * Flatten a sentinel's usage report into readings this module can judge.
 *
 * A profile with no `fiveHour` window -- unauthed, errored, never polled -- is
 * DROPPED rather than treated as full. It is not evidence of anything, and the
 * distinction matters: `headroomVerdict` refuses only on profiles it can see, so
 * a dropped one can never contribute to a refusal.
 */
export function readingsFrom(snapshots: readonly ProfileUsageSnapshot[], nowMs: number): ProfileHeadroom[] {
  const out: ProfileHeadroom[] = []
  for (const snap of snapshots) {
    if (!snap.fiveHour) continue
    const resetAt = Date.parse(snap.fiveHour.resetAt)
    out.push({
      profile: snap.profile,
      fiveHourUsedPercent: snap.fiveHour.usedPercent,
      msUntilFiveHourReset: Number.isFinite(resetAt) ? Math.max(0, resetAt - nowMs) : 0,
      stale: snap.stale === true || snap.error !== undefined,
    })
  }
  return out
}

/**
 * ONE ROW PER PROFILE NAME, across every connected sentinel.
 *
 * The same profile on two sentinels is ONE account with ONE 5h window, so two
 * rows for it would let a single throttled account count twice toward "every
 * profile is gated" -- or, worse, let a stale optimistic copy hold the gate open
 * beside a fresh one that says it is full.
 *
 * FRESH BEATS STALE; among two fresh, the HIGHER used% wins. Deliberately
 * asymmetric: the cost of believing the pessimistic copy is one held beat that
 * clears on the next poll, and the cost of believing the optimistic one is a
 * seat burned into a capped account, producing nothing and settling as done.
 */
export function mergeReadings(readings: readonly ProfileHeadroom[]): ProfileHeadroom[] {
  const byProfile = new Map<string, ProfileHeadroom>()
  for (const r of readings) {
    const seen = byProfile.get(r.profile)
    if (!seen || better(r, seen)) byProfile.set(r.profile, r)
  }
  return [...byProfile.values()]
}

function better(candidate: ProfileHeadroom, seen: ProfileHeadroom): boolean {
  if (seen.stale !== candidate.stale) return !candidate.stale
  return candidate.fiveHourUsedPercent > seen.fiveHourUsedPercent
}

/**
 * MAY THIS RUN DISPATCH? Blocked only when EVERY profile it could use is gated.
 *
 * Three ways to answer NO-BLOCK, and each is a decision rather than a fallthrough:
 *
 * 1. **No readings at all.** Absent means no gate, the same convention `queue`
 *    and `producedOutput` use. A caller that has not wired telemetry up gets
 *    today's behaviour rather than a silently withheld dispatch.
 * 2. **Every reading is stale.** UNMEASURED IS NOT EMPTY. This is the whole point
 *    of the 429 carry-forward: a throttled probe is not evidence of no capacity,
 *    and refusing on it would let one failed poll freeze a fleet that is fine.
 * 3. **One fresh profile has room.** Refusing while a sibling sits at 3% is the
 *    exact failure carry-forward was written to prevent.
 *
 * PACE IS DELIBERATELY NOT IMPLEMENTED, and the card's formula is why. It reads
 * `usedPercent / elapsedFraction(window)`, which is unbounded as a window rolls
 * over: one minute after a reset the elapsed fraction is ~0, so ANY usage yields
 * an enormous pace and every run holds. The idea (catch the slow bleed that
 * arrives at the cliff mid-run) is sound and the arithmetic is not; it wants a
 * floor on elapsed time before the ratio means anything. Left out rather than
 * shipped wrong -- the hard gate below is what the card's tests actually specify.
 */
export function headroomVerdict(readings: readonly ProfileHeadroom[] | undefined): HeadroomVerdict {
  if (!readings || readings.length === 0) return CLEAR

  const fresh = readings.filter(r => !r.stale)
  if (fresh.length === 0) return CLEAR

  const gated = fresh.filter(r => clampPercent(r.fiveHourUsedPercent) >= GATE_FIVE_HOUR_PCT)
  if (gated.length < fresh.length) return CLEAR

  return { blocked: true, reason: bindingReason(gated, fresh.length) }
}

function clampPercent(pct: number): number {
  return Math.max(0, Math.min(100, pct))
}

/**
 * The line a held beat says, every beat it is held.
 *
 * IT CARRIES THE COUNTDOWN, for the same reason the appointment gate does: a run
 * holding for headroom has nothing in flight and nothing to show for itself,
 * which on every surface here is indistinguishable from a run that quietly died.
 * The binding profile is the one whose window frees SOONEST -- that is when this
 * run can move again, so it is the only countdown worth printing.
 */
function bindingReason(gated: readonly ProfileHeadroom[], total: number): string {
  const soonest = gated.reduce((a, b) => (b.msUntilFiveHourReset < a.msUntilFiveHourReset ? b : a))
  const pct = Math.round(clampPercent(soonest.fiveHourUsedPercent))
  return (
    `no plan headroom: all ${total} profile(s) are at or over the ${GATE_FIVE_HOUR_PCT}% 5h gate ` +
    `-- soonest is ${soonest.profile} at ${pct}%, free in ${formatDuration(soonest.msUntilFiveHourReset)}`
  )
}
