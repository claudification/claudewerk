/**
 * Recognize a PROJECT BOARD CARD inside a relative markdown link.
 *
 * A card path is a real file, so it would otherwise open in the sentinel-backed
 * markdown viewer -- a read-only dump of raw frontmatter. The card is the same
 * bytes rendered as something you can edit, move and run, so a link pointing at
 * one opens the Kanban card editor instead.
 *
 * Cards live at `.rclaude/project/cards/<id>.md` and never move. Links written
 * against the OLD layout (`.rclaude/project/<lane>/<id>.md`) and against the
 * generated view symlinks (`.rclaude/project/views/<lane>/<id>.md`) resolve to
 * the same card -- the lane in the path is ignored entirely, because the card
 * is addressed by id.
 *
 * The matching itself lives in `@shared/card-path` so this and the sentinel
 * cannot drift.
 */

import { canonicalizeCardPath } from '@shared/card-path'

export interface ProjectCardRef {
  /** The card id -- the whole primary key. */
  id: string
}

/** The board card a project-relative path points at, or null for a plain file. */
export function parseProjectCardPath(relPath: string): ProjectCardRef | null {
  const hit = canonicalizeCardPath(relPath)
  return hit ? { id: hit.id } : null
}
