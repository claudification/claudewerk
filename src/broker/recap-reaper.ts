/**
 * RECAP REAPER -- the live backstop for stuck recaps.
 *
 * The recap render races an in-process overall deadline (deadline.ts), and the
 * boot sweep (sweepInterrupted) reclaims runs orphaned by a broker restart. This
 * periodic loop closes the last gap: a run wedged while the broker STAYS UP whose
 * in-process timer somehow never fired (a hang outside the raced render, a lost
 * timer, a bug). Every sweep it force-fails any in-flight recap gone silent past
 * the reap ceiling, so a recap is ALWAYS driven to a terminal, reported state --
 * never a forever-spinning bar.
 *
 * It also runs the bundle retention prune (keep banked map/merge output ~30 days
 * for cost-safe resume, then reclaim disk), gated to at most once an hour.
 *
 * Mirrors nightshift-watchdog: a plain setInterval, no LLM, self-catching so a
 * sweep crash never takes the broker down.
 */

import type { RecapOrchestrator } from './recap-orchestrator'

/** Sweep cadence. The reap ceiling is tens of minutes, so a 1-min tick is ample
 *  and cheap (one indexed COUNT + a MAX(timestamp) per in-flight row). */
const SWEEP_MS = 60_000
/** Retention prune runs at most this often (fs walk over the bundle root). */
const PRUNE_INTERVAL_MS = 60 * 60_000

export interface RecapReaperDeps {
  orchestrator: Pick<RecapOrchestrator, 'reapStale' | 'pruneBundles'>
  /** Injectable clock for tests. */
  now?: () => number
}

export function startRecapReaper(deps: RecapReaperDeps): { stop: () => void; sweep: () => void } {
  const now = deps.now ?? Date.now
  // NEGATIVE_INFINITY so the FIRST sweep always prunes (retention on boot),
  // regardless of the injected clock; thereafter it's gated to once per hour.
  let lastPruneAt = Number.NEGATIVE_INFINITY

  function sweep(): void {
    const reaped = deps.orchestrator.reapStale()
    if (reaped.length > 0) {
      console.log(`[recap-reaper] reaped ${reaped.length} stuck recap(s): ${reaped.map(r => r.id).join(', ')}`)
    }
    if (now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now()
      const pruned = deps.orchestrator.pruneBundles()
      if (pruned.length > 0) console.log(`[recap-reaper] pruned ${pruned.length} expired bundle(s)`)
    }
  }

  function guardedSweep(): void {
    try {
      sweep()
    } catch (err) {
      console.error('[recap-reaper] sweep crashed -- swallowing:', err)
    }
  }

  guardedSweep() // run immediately on boot (crash-guarded so a bad sweep can't abort startup)
  const timer = setInterval(guardedSweep, SWEEP_MS)
  return { stop: () => clearInterval(timer), sweep }
}
