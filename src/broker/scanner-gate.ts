/**
 * THE PER-PROJECT OPT-IN, ON THE CALLER'S SIDE OF THE LINE -- one implementation,
 * for every scanner that has a clock.
 *
 * `scanner-opt-in.ts` (in `src/shared`) owns the PREDICATE, because the checkbox
 * in the browser reads the same default the broker does. This file owns the
 * STORE-BACKED spelling of it plus the two things a caller does with it: narrow a
 * project list, and say out loud what the narrowing removed.
 *
 * THE CALLER CHECKS, NOT THE SCANNER, and that rule is why this module exists at
 * all. A scanner asked to run on a project runs; whether it should have been
 * asked is the fabric's decision. A scanner that consults settings can no longer
 * be tested without them, which is the property the whole contract protects --
 * `src/broker/scanners/` imports nothing from here and nothing there should.
 *
 * THE GATE IS ALSO THE SPEND GATE. Every caller narrows BEFORE it reads a board
 * or compiles a seat, so an opted-out project costs a set lookup and nothing else
 * -- no sentinel round trip, no token, no seat.
 */

import type { ScannerId } from '../shared/scanner-ids'
import { scannerEnabled } from '../shared/scanner-opt-in'
import { getAllProjectSettings, scannerEnabledForProject, stampScannerRun } from './project-settings'

/**
 * ONE SCANNER'S OPT-IN, as three injected effects.
 *
 * `enabled` and `projects` are not the same question and neither derives from the
 * other. `enabled` takes whatever project string a conversation or an RPC caller
 * happens to carry and normalizes it before looking it up; `projects` enumerates
 * the already-canonical keys of every project that ticked the box, including the
 * ones with no work at all -- which is precisely the project whose "last ran"
 * stamp is worth having.
 */
export interface ScannerOptIn {
  /** Canonical URIs of every project with this scanner switched on. */
  projects: () => string[]
  /** May this (possibly non-canonical) project be swept? Default off. */
  enabled: (project: string) => boolean
  /** A pass just finished for this project. Epoch ms. */
  stamp: (project: string, at: number) => void
}

/**
 * The real gate for one scanner: project settings, read live.
 *
 * Every method reads the settings store at the MOMENT IT IS ASKED rather than
 * closing over a snapshot, which is what makes ticking the box take effect on the
 * next tick instead of at the next broker restart.
 *
 * One factory rather than a hand-written record per scanner. The three lines are
 * identical for all five and only the id differs, so a per-scanner copy is five
 * chances to spell the default `?? true` -- the exact failure `scanner-opt-in.ts`
 * says in its own header it exists to make impossible.
 */
export function buildScannerOptIn(id: ScannerId): ScannerOptIn {
  return {
    projects: () =>
      Object.entries(getAllProjectSettings())
        .filter(([, s]) => scannerEnabled(s, id))
        .map(([project]) => project),
    enabled: project => scannerEnabledForProject(project, id),
    stamp: (project, at) => stampScannerRun(project, id, at),
  }
}

/**
 * WHY A SKIP IS LOGGED AT ALL, and why it is not logged every tick.
 *
 * Logged, because the scanner contract's one rule is that a unit the engine
 * looked at and did nothing about must never vanish quietly -- and a gate that
 * silently deleted half the board would be that same silent drop, just moved one
 * layer above where `runScan`'s accounting can see it. A person who ticked one
 * box and is waiting on another needs the log line to name which box.
 *
 * Not every tick, because these clocks run once a minute forever. A line per tick
 * per scanner naming every project on the box is thousands of identical lines a
 * day, and a log nobody can read is the same silence with more disk. So the
 * skipped SET is remembered and the line is emitted only when it changes -- which
 * is exactly when it is news: a project appeared, a box was ticked, a box was
 * unticked.
 */
export interface SkipLog {
  /** Log the skipped projects if the set changed since the last call. */
  note: (skipped: readonly string[]) => void
}

/** A change-detecting skip logger for one scanner. Stateful, so one per clock. */
export function buildSkipLog(id: ScannerId, log: (line: string) => void): SkipLog {
  // `null` rather than an empty string: "never reported" and "reported that
  // nothing is skipped" are different states, and only the first should be
  // allowed to stay silent when the answer is genuinely nothing.
  let last: string | null = null
  return {
    note: skipped => {
      const key = [...skipped].sort().join(',')
      if (key === last) return
      const first = last === null
      last = key
      if (skipped.length === 0) {
        // "Nothing is skipped" is only news if something WAS. On the very first
        // call it is the ordinary state of a broker that has no projects yet, or
        // whose projects all opted in, and announcing it would make the clock's
        // first word a line about nothing.
        if (!first) log(`[scanner:${id}] every known project now has the "${id}" scanner on`)
        return
      }
      log(
        `[scanner:${id}] skipped ${skipped.length} project(s) with the "${id}" scanner off: ${[...skipped].sort().join(', ')} ` +
          '-- tick it in Project Settings > Scanners',
      )
    },
  }
}

/**
 * Split a project list into the ones this scanner may sweep and the ones it may
 * not, and report the second half.
 *
 * `all` is the broker's KNOWN projects and `optIn.projects()` is the settings'
 * ENABLED ones, and this deliberately unions rather than filtering one by the
 * other. A project can be enabled and absent from `all` (settings outlive a
 * registry row) and it must still be swept, because its stamp is the only thing
 * that would ever say the loop is alive for it. A project can be in `all` and
 * disabled, and that is the one the log line is for.
 */
export function gateProjects(
  all: readonly string[],
  optIn: ScannerOptIn,
  skipLog: SkipLog,
): { run: string[]; skipped: string[] } {
  const run = optIn.projects()
  // `optIn.enabled` and NOT membership of `run`: the two lists are spelt
  // differently. `run` holds canonical settings keys, `all` holds whatever the
  // project registry stored, and `enabled` is the one side that normalizes -- so
  // a set lookup here would report a project as skipped purely for arriving
  // under a profile-qualified URI.
  const skipped = all.filter(project => !optIn.enabled(project))
  skipLog.note(skipped)
  return { run, skipped }
}
