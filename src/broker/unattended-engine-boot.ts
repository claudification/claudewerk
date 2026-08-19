/**
 * WHEN THE UNATTENDED ENGINE STARTED, AND WHETHER IT MAY ACT YET.
 *
 * ONE ENGINE, NOT TWO (decided 2026-08-19). Nightshift and epic mode are the
 * same runner: nightshift is an epic run that scavenges its own work during the
 * night window. They already share the 45s cadence, the "group conversations by
 * launch tag" fold, the "any live conversation means leave it alone" rule, and
 * the reentrancy guard -- each written twice, in modules that have since drifted.
 * This is the first piece pulled back into one place, and the rule from here is
 * that a behaviour either lives here or is deliberately different, never
 * accidentally different because it was implemented in one sweep and not the
 * other.
 *
 * THE QUARANTINE. Every unattended sweep decides what to do by asking which
 * conversations are live. On a fresh broker that answer is EMPTY and WRONG: the
 * agent hosts carrying the launch tags are still reconnecting. Act inside that
 * window and every unit of work looks abandoned -- the epic sweep dispatches a
 * duplicate seat for each in-flight card, and the nightshift guardians treat a
 * running task as an orphan. Both are the same mistake, made from the same
 * missing fact, so both wait on the same clock.
 *
 * Two minutes is the reconnect budget, not a guess at how long a beat takes. A
 * run loses at most one tick and buys back the guarantee that its first decision
 * after a restart is made on a complete picture.
 */

/** How long after boot before any unattended engine may act. */
export const RESTART_QUARANTINE_MS = 120_000

/**
 * When the engine started, or null when nothing marked it -- a direct
 * `sweepEpics` / `sweepGuardians` call (a test, a one-off) is not a restart and
 * is not quarantined.
 */
let bootAtMs: number | null = null

/** Start the quarantine clock. Called by each loop's `start`; idempotent per
 *  boot, so whichever engine starts first sets the clock for both. */
export function markEngineBoot(nowMs: number): void {
  if (bootAtMs === null) bootAtMs = nowMs
}

/** Milliseconds left in the quarantine, or 0 when it is over (or never started). */
export function quarantineRemainingMs(nowMs: number): number {
  if (bootAtMs === null) return 0
  return Math.max(0, bootAtMs + RESTART_QUARANTINE_MS - nowMs)
}

/** The line a held sweep logs. Shared so both engines say the same thing and a
 *  log reader never has to learn two phrasings for one state. */
export function quarantineLogLine(tag: string, remainingMs: number): string {
  return `${tag} restart quarantine -- holding for ${Math.ceil(remainingMs / 1000)}s more while agent hosts reconnect`
}

/** Tests only -- the module-level clock would otherwise leak between cases. */
export function resetEngineBoot(): void {
  bootAtMs = null
}
