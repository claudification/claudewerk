/**
 * Drain a board's legacy lane folders the first time this sentinel watches it.
 *
 * WHY HERE, AND NOWHERE ELSE: migrating a board makes it unreadable to a
 * sentinel that predates the `cards/` layout, so running the sweep by hand
 * before deploying the sentinel blanks the live board. Putting the sweep INSIDE
 * the sentinel makes that ordering mistake impossible -- the thing that
 * migrates is, by construction, the thing that can read the result.
 *
 * Cheap: one `readdirSync` per lane (six ENOENTs on an already-migrated board),
 * once per project per process, at watch start -- never on the poll path.
 * `upgradeProjectBoard` backs every file up before touching it and is
 * idempotent, so a repeat is a no-op.
 *
 * Kill switch: `CLAUDWERK_BOARD_AUTOUPGRADE=0` leaves every board exactly as
 * it is (the store still reads both layouts, so nothing breaks -- boards just
 * keep paying the legacy scan until someone runs `bun run board:upgrade`).
 */

import { hasLegacyCards } from '../shared/project-legacy'
import { upgradeProjectBoard } from '../shared/project-upgrade'

/** Roots already swept in this process. Watches come and go with the lease;
 *  the sweep should not. */
const swept = new Set<string>()

type LogFn = (msg: string) => void

function enabled(): boolean {
  return process.env.CLAUDWERK_BOARD_AUTOUPGRADE !== '0'
}

/**
 * Sweep one board if it still has cards in lane folders. Safe to call on every
 * watch start. Never throws -- a board that cannot be migrated is still fully
 * readable, so a failure here must not take the watch down with it.
 */
export function autoUpgradeBoard(projectRoot: string, log: LogFn, nowMs = Date.now()): void {
  if (swept.has(projectRoot)) return
  swept.add(projectRoot)
  if (!enabled()) return

  try {
    if (!hasLegacyCards(projectRoot)) return

    const r = upgradeProjectBoard(projectRoot, { nowMs })
    log(
      `[board-upgrade] ${projectRoot}: moved ${r.moved.length}/${r.legacy.length} card(s) into cards/` +
        `, backup=${r.backupDir ?? '(none)'}` +
        `, lanesRemoved=[${r.lanesRemoved.join(',')}]` +
        `, collisions=${r.collisions.length}` +
        `, failures=${r.failures.length}`,
    )
    for (const c of r.collisions) {
      log(`[board-upgrade] ${projectRoot}: COLLISION ${c.slug} in [${c.lanes.join(',')}] -- kept "${c.lanes.at(-1)}"`)
    }
    for (const f of r.failures) {
      log(`[board-upgrade] ${projectRoot}: FAILED ${f.from}/${f.slug}.md -- ${f.error}`)
    }
  } catch (err) {
    log(`[board-upgrade] ${projectRoot}: sweep failed, board left as-is -- ${(err as Error).message}`)
  }
}

/** Test seam: forget what has been swept. */
export function resetAutoUpgradeState(): void {
  swept.clear()
}
