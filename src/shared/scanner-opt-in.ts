/**
 * WHICH SCANNERS MAY RUN AGAINST WHICH PROJECT -- read one way, by everybody.
 *
 * OFF BY DEFAULT, every scanner, every project. Absent settings, an absent
 * `scanners` map and an absent key all mean the same thing: no. That is not a
 * convenience default, it is the constraint -- an unattended agent that switches
 * itself on in a repo nobody opted in for is spending somebody's money in
 * somebody's tree.
 *
 * THE PREDICATE LIVES HERE AND NOWHERE ELSE. A second reader that spells the
 * default `?? true` would quietly re-enable everything it touches, and the whole
 * point of one function is that there is no second spelling to get wrong.
 *
 * IN `src/shared` because both ends read it: the broker to gate a sweep, the web
 * to render the checkbox. A checkbox list cannot import broker internals -- the
 * same reason `scanner-ids.ts` sits here.
 *
 * THE CALLER CHECKS, NOT THE SCANNER. Nothing in `src/broker/scanners/` imports
 * this file and nothing there should: a scanner asked to run on a project runs,
 * and whether it should have been asked is the fabric's decision. A scanner that
 * consults settings can no longer be tested without them, which is the property
 * the whole contract exists to protect.
 */

import type { ScannerId } from './scanner-ids'

/** The per-project opt-in map. Absent key = off. */
export type ScannerToggles = Partial<Record<ScannerId, boolean>>

/** Epoch ms of each scanner's last pass over this project. Absent = never ran. */
export type ScannerLastRuns = Partial<Record<ScannerId, number>>

/**
 * The two fields these functions read, and nothing else.
 *
 * STRUCTURAL rather than `ProjectSettings` on purpose: `protocol.ts` imports the
 * aliases above, so taking the whole interface back would close an import cycle
 * for no gain. `ProjectSettings` satisfies this shape, and so does any hand-built
 * object in a test.
 */
export interface ScannerSettings {
  scanners?: ScannerToggles
  scannersLastRun?: ScannerLastRuns
}

/** May this scanner run against this project? Default OFF, always. */
export function scannerEnabled(settings: ScannerSettings | null | undefined, id: ScannerId): boolean {
  return settings?.scanners?.[id] === true
}

/**
 * When did this scanner last complete a pass over this project?
 *
 * `undefined` is the answer that matters: "enabled, last ran never" is the shape
 * of every engine that died quietly in this codebase (nightshift: 0 runs since
 * June; scheduled tasks: 0 ever; quests: 0 ever). A row that can say it is a row
 * somebody looks at.
 */
export function scannerLastRun(settings: ScannerSettings | null | undefined, id: ScannerId): number | undefined {
  return settings?.scannersLastRun?.[id]
}

/**
 * The toggles as they should be STORED: only the true ones, and `undefined`
 * when none are on.
 *
 * Storing `{refine: false, epics: false, ...}` would mean a project that has
 * never been configured and a project explicitly configured to all-off are two
 * different rows saying the same thing, and `setProjectSettings` strips
 * `undefined` -- so an all-off save removes the key rather than persisting five
 * falses forever.
 */
export function packScannerToggles(toggles: ScannerToggles): ScannerToggles | undefined {
  const on = Object.entries(toggles).filter(([, v]) => v === true)
  return on.length > 0 ? (Object.fromEntries(on) as ScannerToggles) : undefined
}
