/**
 * When does a headless worker EXIT after a turn result?
 *
 * CC in stream-json mode stays alive waiting for more stdin, so a single-prompt
 * fire-and-forget worker (adHoc) must be told to exit -- otherwise it idles until
 * something reaps it. That was H7 finding 2: nightshift/quest workers were spawned
 * headless but NOT adHoc, so this seam never fired and they lingered idle until the
 * watchdog idle-cap reaped them (wasted slot + wall-clock). The dispatch now marks
 * them adHoc; this predicate is the exit gate they ride.
 *
 * `leaveRunning` (only meaningful with adHoc) keeps the session up for follow-up
 * work. Non-adHoc headless sessions (interactive daemon workers) always stay alive.
 */
export interface AdHocExitEnv {
  adHoc: boolean
  leaveRunning: boolean
}

/** True => shut the worker down after this result. */
export function shouldExitAfterResult(env: AdHocExitEnv): boolean {
  return env.adHoc && !env.leaveRunning
}

/** Read the exit gate straight from the process env the sentinel set. */
export function shouldExitAfterResultFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return shouldExitAfterResult({
    adHoc: env.RCLAUDE_ADHOC === '1',
    leaveRunning: env.RCLAUDE_LEAVE_RUNNING === '1',
  })
}
