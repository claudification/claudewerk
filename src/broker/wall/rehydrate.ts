/**
 * Boot seam: refill THE WALL's in-memory rings from the durable stats store.
 *
 * The ring stays the hot read -- the ~2 Hz frame is still built from it, and
 * nothing on the serving path touches SQLite. This runs ONCE, after
 * `initStatsStore()` and before any node or sentinel has reported, so that
 * `docker compose up -d` resumes the sparkline and the 5h chart instead of
 * coming back blank. A blank wall on a live fleet is visually identical to a
 * quiet one, which is the failure that makes an ambient wall untrustworthy.
 *
 * Each producer decides for itself how much history it may honestly take back;
 * neither of them interpolates across the outage. See `host-vitals.ts` for why
 * the CPU ring refuses a long gap outright, and `WallPlanSample.gapBefore` for
 * how the plan chart marks one.
 */

import { rehydrateWallHostVitals } from './host-vitals'
import { rehydratePlanSeries } from './plan-usage-series'

export function rehydrateWallRings(now: number = Date.now()): void {
  const nodes = rehydrateWallHostVitals(now)
  const plan = rehydratePlanSeries(now)
  if (nodes === 0 && plan === 0) return
  console.log(`[wall] rehydrated ${nodes} node CPU ring(s) + ${plan} plan sample(s) from the stats store`)
}
