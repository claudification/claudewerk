/**
 * Overall recap wall-clock deadline -- the ONE governing timeout for a run.
 *
 * Per-LLM-call timeouts (openrouter-client) bound a single call; the map-stage
 * deadline bounds the parallel extraction barrier. Neither caps the WHOLE job,
 * so a hung reduce/synthesize (incident recap_bi10fng0a1sz: ~10min frozen at 78%
 * on one wedged Opus call) showed a dead progress bar with no upper bound. This
 * is the master cap: the render phase races against a deadline SCALED BY
 * CONVERSATION COUNT (Jonas: "a function of number of conversations -- 10 convs
 * => 1 min, 250 => 25 min"). On a trip the run throws RecapDeadlineError, which
 * the scheduleRun catch turns into a `failed` row (banked bundle survives on
 * disk for a cost-safe resume).
 *
 * Every knob is env-overridable (ops + test seam), mirroring the existing
 * CLAUDWERK_RECAP_* seams.
 */

/** Linear budget per conversation. 6s/conv reproduces Jonas's example exactly:
 *  10 conv -> 60s (floor), 250 conv -> 1_500_000ms = 25min. */
const MS_PER_CONV = 6_000
/** Floor: even a tiny recap gets at least this (one slow Opus reduce fits). */
const FLOOR_MS = 60_000
/** Ceil: keeps even a huge month-recap bounded (was the old 45min map ceil). */
const CEIL_MS = 30 * 60_000

function envMs(key: string): number | undefined {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : undefined
}

/**
 * Overall wall-clock budget (ms) for a recap render, given its conversation
 * count. A flat CLAUDWERK_RECAP_OVERALL_DEADLINE_MS override wins outright (ops
 * kill-switch / tests); otherwise the per-conv/floor/ceil knobs each override.
 */
export function overallDeadlineMs(convCount: number): number {
  const flat = envMs('CLAUDWERK_RECAP_OVERALL_DEADLINE_MS')
  if (flat) return flat
  const perConv = envMs('CLAUDWERK_RECAP_MS_PER_CONV') ?? MS_PER_CONV
  const floor = envMs('CLAUDWERK_RECAP_DEADLINE_FLOOR_MS') ?? FLOOR_MS
  const ceil = envMs('CLAUDWERK_RECAP_DEADLINE_CEIL_MS') ?? CEIL_MS
  const raw = Math.max(0, Math.ceil(convCount)) * perConv
  return Math.min(ceil, Math.max(floor, raw))
}

/** The reaper's absolute backstop: the longest ANY in-flight recap may live
 *  (since last activity) before a live sweep force-fails it. Sits above the
 *  overall deadline ceil so it only catches true orphans/wedges the in-process
 *  race missed (e.g. a broker that stayed up while a run went silent). */
export function reapCeilingMs(): number {
  return envMs('CLAUDWERK_RECAP_REAP_CEILING_MS') ?? CEIL_MS + 5 * 60_000
}

/** Thrown when the overall deadline fires. Carried through the scheduleRun catch
 *  to a `failed` row -- never swallowed. */
export class RecapDeadlineError extends Error {
  constructor(deadlineMs: number, convCount: number) {
    super(
      `recap exceeded its overall deadline (${Math.round(deadlineMs / 1000)}s for ${convCount} conversation(s)) -- ` +
        'the render stage was force-failed; banked map/merge output is kept for a cost-safe resume',
    )
    this.name = 'RecapDeadlineError'
  }
}

/**
 * Race `fn()` against a deadline. If the deadline wins, reject with
 * RecapDeadlineError; `fn`'s promise keeps running until its own late settle
 * (its late rejection is swallowed so it never surfaces as an unhandledRejection
 * -- same pattern as openrouter-client's attemptOnce). A non-positive `ms`
 * (deadline already blown before arming) fails fast without starting the timer.
 */
export async function withDeadline<T>(ms: number, convCount: number, fn: () => Promise<T>): Promise<T> {
  if (ms <= 0) throw new RecapDeadlineError(ms, convCount)
  const work = fn()
  work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RecapDeadlineError(ms, convCount)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
