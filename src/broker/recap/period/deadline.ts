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

/**
 * Per-call timeout for the calls that generate the FULL document (oneshot /
 * reduce, up to 32k output tokens). A legitimate Opus synthesis runs MINUTES.
 * It lives here, next to the overall deadline, on purpose: the overall deadline
 * must never out-race the per-call timeout it governs, and the only way to
 * guarantee that is to derive one from the other in a single file.
 */
export const RECAP_SYNTHESIS_TIMEOUT_MS = 240_000
/** The MAP call is fast, cheap extraction -- it gets a much tighter bound. */
export const RECAP_MAP_TIMEOUT_MS = 120_000
/** A hung call must not draw the full rate-limit retry budget (240s x 3 = 12min
 *  of dead air). One timeout retry, then degrade -- the stage deadline backstops. */
export const RECAP_TIMEOUT_RETRIES = 1

/** Linear budget per conversation -- this covers GATHER + the parallel map
 *  stage, the parts that genuinely scale with how many conversations there are. */
const MS_PER_CONV = 6_000
/** Slack on top of the synthesis call itself: parse-retry, finalize, persist. */
const SYNTHESIS_SLACK_MS = 60_000
/** Floor: reserve + slack, so even a 1-conv recap can finish a slow synthesis. */
const FLOOR_MS = RECAP_SYNTHESIS_TIMEOUT_MS + SYNTHESIS_SLACK_MS
/** Ceil: keeps even a huge month-recap bounded (was the old 45min map ceil). */
const CEIL_MS = 30 * 60_000

function envMs(key: string): number | undefined {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : undefined
}

/**
 * Fixed wall-clock reserved for the final synthesis, INDEPENDENT of conversation
 * count. Incident recap_gztgs07tmyn8: the old budget scaled only with conv count
 * (6s x 15 = 90s) while the one Opus call it had to cover took 131.8s -- so the
 * run was force-failed 42s before its own successful, already-billed output
 * landed. Whether a recap merges 15 conversations or 150, it ends in ONE
 * document-generating call bounded by RECAP_SYNTHESIS_TIMEOUT_MS; that cost is
 * a constant, so it belongs in the budget as a constant.
 */
export function synthesisReserveMs(): number {
  return envMs('CLAUDWERK_RECAP_SYNTHESIS_RESERVE_MS') ?? RECAP_SYNTHESIS_TIMEOUT_MS
}

/**
 * Overall wall-clock budget (ms) for a recap render: the fixed synthesis reserve
 * PLUS the per-conversation gather/map budget, clamped to [floor, ceil]. A flat
 * CLAUDWERK_RECAP_OVERALL_DEADLINE_MS override wins outright (ops kill-switch /
 * tests); otherwise the reserve/per-conv/floor/ceil knobs each override.
 */
export function overallDeadlineMs(convCount: number): number {
  const flat = envMs('CLAUDWERK_RECAP_OVERALL_DEADLINE_MS')
  if (flat) return flat
  const perConv = envMs('CLAUDWERK_RECAP_MS_PER_CONV') ?? MS_PER_CONV
  const floor = envMs('CLAUDWERK_RECAP_DEADLINE_FLOOR_MS') ?? FLOOR_MS
  const ceil = envMs('CLAUDWERK_RECAP_DEADLINE_CEIL_MS') ?? CEIL_MS
  const raw = synthesisReserveMs() + Math.max(0, Math.ceil(convCount)) * perConv
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
