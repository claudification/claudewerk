/**
 * The SHAPE of a board card path -- pure string work, no `node:` imports, so
 * the control panel bundle and the sentinel share one definition instead of
 * drifting regexes.
 *
 * A card lives at `.rclaude/project/cards/<id>.md` and never moves; its lane is
 * a `status:` frontmatter key. But the board spent a long time keyed on
 * `<status>/<id>.md`, so links in transcripts, docs, commit messages and card
 * bodies point at lanes the card left months ago. Every one of those must still
 * open the card -- that is what `canonicalizeCardPath` is for. It is the single
 * chokepoint: file viewer, markdown link handler and card deep-link all run
 * their input through it.
 */

import { TASK_STATUS_PATTERN } from './task-statuses'

/** Canonical card directory, relative to the board root. */
export const CARDS_DIR = 'cards'
/**
 * The old generated symlink-view directory. The farm itself is GONE (deleted
 * 2026-08-13, see project-paths.ts) -- this constant survives for exactly one
 * reason: links written while it existed must keep opening their card forever.
 * Nothing creates this directory any more.
 */
export const VIEWS_DIR = 'views'

/** Board-relative path of one card -- the form agents are told to link. */
export function cardRelPath(id: string): string {
  return `.rclaude/project/${CARDS_DIR}/${id}.md`
}

/**
 * Every historical shape a card path has taken:
 *   `.rclaude/project/cards/<id>.md`          canonical
 *   `.rclaude/project/<lane>/<id>.md`         legacy lane (pre-migration links)
 *   `.rclaude/project/views/<lane>/<id>.md`   the deleted symlink farm
 * optionally prefixed by `./` or a repo path, optionally suffixed `#frag`/`?q`.
 */
const BOARD_CARD_PATH = new RegExp(
  `(?:^|/)\\.rclaude/project/(?:${CARDS_DIR}|(?:${VIEWS_DIR}/)?(?:${TASK_STATUS_PATTERN}))/([^/]+)\\.md$`,
  'i',
)

export interface CardPathRef {
  /** The card id -- the whole primary key. */
  id: string
  /** Where it actually lives, whatever the input pointed at. */
  relPath: string
}

/** The board card a path points at, or null if it is a plain file. */
export function canonicalizeCardPath(relPath: string): CardPathRef | null {
  if (!relPath) return null
  const bare = relPath.split('#')[0].split('?')[0]
  const m = BOARD_CARD_PATH.exec(bare)
  if (!m) return null
  return { id: m[1], relPath: cardRelPath(m[1]) }
}
