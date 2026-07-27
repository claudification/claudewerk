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
export const RECAP_SYNTHESIS_TIMEOUT_MS = 420_000
/** The MAP call is fast, cheap extraction -- it gets a much tighter bound. */
export const RECAP_MAP_TIMEOUT_MS = 120_000
/** A hung call must not draw the full rate-limit retry budget (240s x 3 = 12min
 *  of dead air). One timeout retry, then degrade -- the stage deadline backstops. */
export const RECAP_TIMEOUT_RETRIES = 1
/** The parse-REPAIR call (parseOrRetry) gets NO timeout retry. It is already the
 *  second bite at the same document; a third identical attempt is pure spend. */
export const RECAP_PARSE_REPAIR_TIMEOUT_RETRIES = 0

/**
 * How many document-generating calls the synthesis phase may consume, worst
 * case. This is the ONE number the reserve is derived from, and it is derived
 * from the retry knobs directly so the budget can never drift from the policy
 * it is supposed to cover:
 *   - the synthesize call itself                        -> 1
 *   - its timeout retries                               -> RECAP_TIMEOUT_RETRIES
 *   - one parse-REPAIR call when the YAML comes back bad -> 1
 */
export const SYNTHESIS_ATTEMPT_BUDGET = 1 + RECAP_TIMEOUT_RETRIES + 1 + RECAP_PARSE_REPAIR_TIMEOUT_RETRIES

/** Linear budget per conversation -- this covers GATHER + the parallel map
 *  stage, the parts that genuinely scale with how many conversations there are. */
const MS_PER_CONV = 6_000
/** Slack on top of the synthesis calls themselves: finalize, persist, render. */
const SYNTHESIS_SLACK_MS = 60_000
/**
 * Ceil: keeps even a huge month-recap bounded.
 *
 * Raised 30min -> 45min alongside the honest reserve. The reserve is now ~22min
 * of the budget, so a 30min ceil left barely 8min of per-conversation headroom
 * and silently squeezed anything past ~80 conversations -- the 2026-07-22
 * nightly (81 convs) landed exactly there. A ceil that eats the reserve
 * re-creates the bug it is supposed to bound. Wall-clock is not what costs
 * money here (the call count is, and cancellation now bounds that), so the ceil
 * can afford to sit above the worst legitimate run.
 */
const CEIL_MS = 45 * 60_000

function envMs(key: string): number | undefined {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : undefined
}

/**
 * Fixed wall-clock reserved for the synthesis PHASE, INDEPENDENT of conversation
 * count.
 *
 * Incident recap_gztgs07tmyn8 (2026-07-22): the budget scaled only with conv
 * count (6s x 15 = 90s) while the one Opus call it had to cover took 131.8s --
 * the run was force-failed 42s before its own successful, already-billed output
 * landed. That bought the fixed reserve.
 *
 * Incident recap_794ve8zetwsa (2026-07-27) proved the fix was HALF-DONE: the
 * reserve was one RECAP_SYNTHESIS_TIMEOUT_MS, i.e. exactly ONE attempt, while
 * the call site is configured `timeoutRetries: RECAP_TIMEOUT_RETRIES` (a second
 * attempt) and parseOrRetry can fire a THIRD. The reduce timed out at 240s,
 * retried, and succeeded at 467s -- 167s after the deadline had already killed
 * the run and thrown the finished document away. 19 of 20 nightly runs died
 * this way, $58 of the $75 spent in 30 days bought nothing. A budget that
 * cannot cover its own retry policy is not a budget, so the reserve is now
 * derived from that policy (SYNTHESIS_ATTEMPT_BUDGET) rather than guessed.
 */
export function synthesisReserveMs(): number {
  return (
    envMs('CLAUDWERK_RECAP_SYNTHESIS_RESERVE_MS') ??
    RECAP_SYNTHESIS_TIMEOUT_MS * SYNTHESIS_ATTEMPT_BUDGET + SYNTHESIS_SLACK_MS
  )
}

/** Floor: the whole synthesis phase, so even a 1-conv recap can finish a slow
 *  one. Derived from the reserve -- never a separate literal that can drift. */
function floorMs(): number {
  return envMs('CLAUDWERK_RECAP_DEADLINE_FLOOR_MS') ?? synthesisReserveMs()
}

/**
 * Overall wall-clock budget (ms) for a recap render: the fixed synthesis reserve
 * PLUS the per-conversation gather/map budget, clamped to [floor, ceil]. A flat
 * CLAUDWERK_RECAP_OVERALL_DEADLINE_MS override wins outright (ops kill-switch /
 * tests); otherwise the reserve/per-conv/floor/ceil knobs each override.
 *
 * The floor is applied LAST on purpose: a ceil below the floor (a careless
 * env override) must never win, or we are back to force-failing runs that were
 * always going to need more time than the budget allowed.
 */
export function overallDeadlineMs(convCount: number): number {
  const flat = envMs('CLAUDWERK_RECAP_OVERALL_DEADLINE_MS')
  if (flat) return flat
  const perConv = envMs('CLAUDWERK_RECAP_MS_PER_CONV') ?? MS_PER_CONV
  const ceil = envMs('CLAUDWERK_RECAP_DEADLINE_CEIL_MS') ?? CEIL_MS
  const raw = synthesisReserveMs() + Math.max(0, Math.ceil(convCount)) * perConv
  return Math.max(floorMs(), Math.min(ceil, raw))
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
 *
 * `fn` receives an AbortSignal that fires the instant the deadline does. Letting
 * the losing work run on is what made a dead run keep BILLING: on 2026-07-26 a
 * force-failed recap went on to complete its Opus synthesis AND fire a parse
 * repair, $1.77 spent after the row already said `failed`. Work that ignores the
 * signal still cannot hold the caller (the race already returned) -- the signal
 * is how it stops spending, not how it stops blocking.
 */
export async function withDeadline<T>(
  ms: number,
  convCount: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (ms <= 0) throw new RecapDeadlineError(ms, convCount)
  const ctrl = new AbortController()
  const work = fn(ctrl.signal)
  work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort()
          reject(new RecapDeadlineError(ms, convCount))
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
