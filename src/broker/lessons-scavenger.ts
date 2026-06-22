/**
 * Lessons-Learned Scavenger ("Overwatch") -- TIER 1: the nightly scavenge.
 *
 * Once per night, for every OPTED-IN project (ProjectSettings.lessonsEnabled),
 * kick a `lessons-learned` recap over a fixed rolling 7-day window. The recap
 * map-reduce (which reads transcripts properly) IS the synthesis; its output
 * lands in recaps_fts as the clean, searchable knowledge layer. Raw transcript
 * FTS stays the drill-down-to-source tool. [[project_lessons_scavenger]]
 *
 * Cost discipline (Jonas's concern): an ACTIVITY GATE skips any project with no
 * conversation activity in the window BEFORE spending a single token; the
 * orchestrator's 5-min cache + signals_hash dedup guard re-runs.
 *
 * This module is dependency-injected end to end (no module-singleton imports) so
 * the loop is unit-testable with a fake clock + fake store. The broker
 * (`index.ts`) wires the concretions (recapOrch, project store, settings).
 *
 * Tier 2 (weekly compaction + the cross-project tech registry) lives in
 * `lessons-compaction.ts` and reuses the deterministic merge primitives.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_HOUR = 4 // 04:00 local -- quiet hours

export interface LessonsScavengerDeps {
  /** Clock seam (tests inject a fixed now). */
  now: () => number
  /** Structured log line (LOG-EVERYTHING covenant). */
  log: (msg: string) => void
  /** Every known project URI (canonical). The loop filters to enabled ones. */
  listProjectUris: () => string[]
  /** Is the lessons scavenger opted in for this project? (default off). */
  isEnabled: (projectUri: string) => boolean
  /** Cheap activity gate: any conversation activity in [sinceMs, now]? Run
   *  BEFORE startLessons so an idle project costs nothing. */
  hasActivitySince: (projectUri: string, sinceMs: number) => boolean
  /** Kick a rolling-7d lessons recap for the project. Returns the recap id +
   *  whether it was served from cache (no new spend). */
  startLessons: (projectUri: string) => Promise<{ recapId: string; cached: boolean }>
  /** Record the last successful scavenge time (observability / not a watermark). */
  markRun: (projectUri: string, ts: number) => void
  /** Rolling window length in days (default 7) -- the activity-gate lookback. */
  windowDays?: number
  /** Wall-clock hour (local, 0-23) the nightly run fires at (default 4). */
  hour?: number
}

export interface ScavengeResult {
  considered: number
  enabled: number
  skippedIdle: number
  started: number
  cached: number
  failed: number
}

/**
 * Run ONE scavenge pass over all projects. Pure w.r.t. its injected deps --
 * sequential on purpose (nightly, not latency-sensitive; keeps LLM concurrency
 * and cost bounded). Never throws: a single project's failure is logged and the
 * pass continues.
 */
export async function scavengeOnce(deps: LessonsScavengerDeps): Promise<ScavengeResult> {
  const windowMs = (deps.windowDays ?? 7) * DAY_MS
  const since = deps.now() - windowMs
  const result: ScavengeResult = { considered: 0, enabled: 0, skippedIdle: 0, started: 0, cached: 0, failed: 0 }

  for (const projectUri of deps.listProjectUris()) {
    result.considered++
    if (!deps.isEnabled(projectUri)) continue
    result.enabled++

    if (!deps.hasActivitySince(projectUri, since)) {
      result.skippedIdle++
      deps.log(`[lessons] skip idle: ${shortUri(projectUri)} (no activity in ${deps.windowDays ?? 7}d)`)
      continue
    }

    try {
      const { recapId, cached } = await deps.startLessons(projectUri)
      result.started++
      if (cached) result.cached++
      deps.markRun(projectUri, deps.now())
      deps.log(`[lessons] ${cached ? 'cached' : 'started'} ${recapId} for ${shortUri(projectUri)}`)
    } catch (err) {
      result.failed++
      deps.log(`[lessons] FAILED ${shortUri(projectUri)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  deps.log(
    `[lessons] pass complete: ${result.started} started (${result.cached} cached), ${result.skippedIdle} idle, ` +
      `${result.failed} failed, of ${result.enabled} enabled / ${result.considered} projects`,
  )
  return result
}

/** ms from `now` until the next local occurrence of `hour`:00:00. Always > 0. */
export function msUntilNextHour(hour: number, now: number): number {
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now) next.setTime(next.getTime() + DAY_MS)
  return next.getTime() - now
}

/**
 * Start the nightly scavenger: fire at the next local `hour`:00, then every 24h.
 * Unlike file-reaper's boot-run, we do NOT run on boot -- a broker restart should
 * never trigger a fleet-wide LLM spend; the first run waits for the scheduled
 * hour. Returns a stop() for teardown/tests.
 */
export function startLessonsScavenger(deps: LessonsScavengerDeps): () => void {
  const hour = deps.hour ?? DEFAULT_HOUR
  let interval: ReturnType<typeof setInterval> | null = null

  const tick = () => {
    scavengeOnce(deps).catch(err =>
      deps.log(`[lessons] pass threw: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  const wait = msUntilNextHour(hour, deps.now())
  const timeout = setTimeout(() => {
    tick()
    interval = setInterval(tick, DAY_MS)
  }, wait)

  deps.log(`[lessons] scheduled: first run in ${Math.round(wait / 60000)}min (target ${hour}:00 local), then every 24h`)

  return () => {
    clearTimeout(timeout)
    if (interval) clearInterval(interval)
  }
}

function shortUri(uri: string): string {
  const m = uri.match(/[^/]+$/)
  return m ? m[0] : uri
}
