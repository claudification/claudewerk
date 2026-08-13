/**
 * The board's DIRECTORY LAYOUT -- is anything living somewhere the board will
 * never look?
 *
 * The layout covenant says a card lives at `cards/<id>.md` and nowhere else.
 * Two ways that gets violated in practice: cards still sitting in the old
 * `<lane>/` directories (read, but every read pays to scan them), and files
 * dropped somewhere plausible-looking that no code path reads at all. The
 * second is the dangerous one -- a `.md` in the wrong place looks exactly like
 * a card to a human and is invisible to the board.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CARDS_DIR, VIEWS_DIR } from './card-path'
import type { DoctorFinding } from './project-doctor-types'
import { listLegacyCollisions } from './project-legacy'
import { boardRoot } from './project-paths'
import { TASK_STATUSES } from './task-statuses'

/** Board-root entries that are expected and owned by something. */
const KNOWN_ENTRIES = new Set<string>([CARDS_DIR, 'quests', 'priority.md', 'gate.conf'])
/** Generated or historical entries that are fine to find and not worth a line. */
const IGNORED_PREFIXES = ['.upgrade-backup-', '.DS_Store']

function isIgnored(name: string): boolean {
  return IGNORED_PREFIXES.some(p => name.startsWith(p))
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(abs: string): boolean {
  try {
    return statSync(abs).isDirectory()
  } catch {
    return false
  }
}

/** Cards still in `<lane>/`, plus the same id in two lanes at once. */
function legacyFindings(root: string, legacyCount: number): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  if (legacyCount > 0) {
    findings.push({
      check: 'legacy-lane-cards',
      severity: 'warning',
      subject: '.rclaude/project/<lane>/',
      problem: `${legacyCount} card(s) still live in old lane directories -- every board read scans them`,
      remedy: 'run `bun run board:upgrade --root <project>` (dry-run first with -n)',
    })
  }
  for (const collision of listLegacyCollisions(root)) {
    findings.push({
      check: 'legacy-collision',
      severity: 'error',
      subject: collision.slug,
      problem: `the same id exists in ${collision.lanes.length} lanes (${collision.lanes.join(', ')}) -- which one is the card is ambiguous`,
      remedy: `keep one, delete the rest; board:upgrade would keep "${collision.lanes[collision.lanes.length - 1]}"`,
    })
  }
  return findings
}

/**
 * The deleted symlink farm, if this board still has one on disk. Nothing
 * creates or maintains it any more, so from here on it can only get more wrong
 * -- but it is the USER'S directory and these boards are not in git, so the
 * doctor says so and hands over the command. It never deletes it.
 */
function leftoverFarmFindings(root: string): DoctorFinding[] {
  const farm = join(boardRoot(root), VIEWS_DIR)
  if (!isDir(farm)) return []
  return [
    {
      check: 'views-leftover',
      severity: 'warning',
      subject: `.rclaude/project/${VIEWS_DIR}/`,
      problem: 'the old symlink farm is still here -- nothing maintains it now, so it only drifts further',
      remedy: `rm -rf ${farm}  (links pointing INTO it still open their card, so nothing breaks)`,
    },
  ]
}

/** Anything directly under the board root that nothing reads. */
function strayFindings(root: string): DoctorFinding[] {
  const board = boardRoot(root)
  const findings: DoctorFinding[] = []
  for (const name of entries(board)) {
    if (KNOWN_ENTRIES.has(name) || isIgnored(name)) continue
    // Reported by their own checks, not as generic strays.
    if (name === VIEWS_DIR) continue
    if ((TASK_STATUSES as readonly string[]).includes(name)) continue
    const isCardLike = name.endsWith('.md')
    findings.push({
      check: isCardLike ? 'stray-card-file' : 'stray-entry',
      severity: isCardLike ? 'warning' : 'info',
      subject: `.rclaude/project/${name}`,
      problem: isCardLike
        ? 'a .md at the board root -- it looks like a card and the board never reads it'
        : 'not part of the board layout, so nothing reads it',
      remedy: isCardLike
        ? `move it to ${CARDS_DIR}/${name} to make it a real card`
        : 'remove it, or leave it knowingly',
    })
  }
  return findings
}

/** Anything inside `cards/` that is not a card. */
function cardsDirFindings(root: string): DoctorFinding[] {
  const dir = join(boardRoot(root), CARDS_DIR)
  const findings: DoctorFinding[] = []
  for (const name of entries(dir)) {
    if (name.endsWith('.md') || isIgnored(name)) continue
    const nested = isDir(join(dir, name))
    findings.push({
      check: nested ? 'cards-nested-dir' : 'cards-non-card-file',
      severity: 'warning',
      subject: `${CARDS_DIR}/${name}`,
      problem: nested
        ? 'a directory inside cards/ -- cards are flat, so nothing in it is ever read'
        : 'not a .md, so it is not a card and nothing reads it',
      remedy: nested ? 'flatten its cards into cards/ or move the directory out of the board' : 'remove it',
    })
  }
  return findings
}

export function checkLayout(root: string, legacyCount: number): DoctorFinding[] {
  return [
    ...legacyFindings(root, legacyCount),
    ...leftoverFarmFindings(root),
    ...strayFindings(root),
    ...cardsDirFindings(root),
  ]
}
