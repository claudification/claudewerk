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

import { canonicalScannerId, type ScannerId } from './scanner-ids'

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

/**
 * READ A STORED MAP BY THE CANONICAL ID, ACCEPTING ANY SPELLING THAT MEANS IT.
 *
 * Both maps below are PERSISTED, so their keys are whatever spelling was current
 * when the row was written -- `work-orders` for every project that ticked that
 * box before the singular rename (`scanner-ids.ts` states why the alias is
 * permanent). Typed `Partial<Record<ScannerId, T>>` and yet iterated as raw
 * strings on purpose: the type describes what we WRITE, and this function exists
 * because it does not describe what is already on disk.
 *
 * The canonical key WINS when both are present. An `||` across spellings would
 * mean a box you just unticked comes back on from its own alias, which is a
 * worse failure than a stale row lingering until the next save.
 */
function readByAnySpelling<T>(map: Partial<Record<ScannerId, T>> | undefined, id: ScannerId): T | undefined {
  if (!map) return undefined
  const direct = map[id]
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(map)) {
    if (canonicalScannerId(key) === id) return value as T
  }
  return undefined
}

/** May this scanner run against this project? Default OFF, always. */
export function scannerEnabled(settings: ScannerSettings | null | undefined, id: ScannerId): boolean {
  return readByAnySpelling(settings?.scanners, id) === true
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
  return readByAnySpelling(settings?.scannersLastRun, id)
}

/**
 * THE MAP, RESPELLED IN CANONICAL IDS -- how an alias drains.
 *
 * Called on the way IN (the settings editor's form state) and again on the way
 * OUT (`packScannerToggles`), which are the two places a stored map becomes a
 * map we are about to write back. Nothing migrates a row on read: the broker
 * reads through `scannerEnabled`, which already accepts either spelling, and a
 * read that rewrites its own input is a read that needs a database handle.
 *
 * CANONICALISING ON LOAD IS NOT COSMETIC. Without it the editor's form state
 * keeps the alias key it loaded, so unticking the box writes
 * `{'work-orders': true, 'work-order': false}` -- the pack below drops the false
 * one, the alias survives, and the scanner stays on. The box would simply not
 * work for exactly the projects the alias exists to serve.
 *
 * A key that is not a scanner in any spelling is DROPPED. Only a hand-edited
 * settings row can produce one, and carrying it forward would mean the union
 * `ScannerId` says nothing about what is in the map.
 */
export function canonicalizeScannerToggles(toggles: ScannerToggles | undefined): ScannerToggles {
  if (!toggles) return {}
  const out: ScannerToggles = {}
  for (const [key, value] of Object.entries(toggles)) {
    const id = canonicalScannerId(key)
    // The canonical spelling wins over an alias, the same rule (and for the same
    // reason) as `readByAnySpelling` -- so an alias may not overwrite it here.
    if (id && !(id in out && key !== id)) out[id] = value
  }
  return out
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
  // Canonical FIRST, then filter: an alias key set to `true` must survive as its
  // canonical spelling rather than be written back as the alias, which is the
  // only thing that ever drains an alias out of the store.
  const on = Object.entries(canonicalizeScannerToggles(toggles)).filter(([, v]) => v === true)
  return on.length > 0 ? (Object.fromEntries(on) as ScannerToggles) : undefined
}
