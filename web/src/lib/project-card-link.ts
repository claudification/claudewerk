/**
 * Recognize a PROJECT BOARD CARD inside a relative markdown link.
 *
 * Agents are told to link cards as `.rclaude/project/{status}/{slug}.md`. That
 * path is a real file, so it would otherwise open in the sentinel-backed
 * markdown viewer -- a read-only dump of the raw frontmatter. The card is the
 * same bytes rendered as something you can edit, move and run, so a link that
 * points at one opens the Kanban card editor instead.
 *
 * The status folder in the link is a HINT, not identity: a card that moved
 * lanes since the link was written still resolves, because the board looks it
 * up by slug.
 */

import { TASK_STATUS_PATTERN, type TaskStatus } from '@shared/task-statuses'

/** `.rclaude/project/<status>/<slug>.md`, optionally prefixed (`./`, a repo path). */
const CARD_PATH = new RegExp(`(?:^|/)\\.rclaude/project/(${TASK_STATUS_PATTERN})/([^/]+)\\.md$`, 'i')

export interface ProjectCardRef {
  slug: string
  /** The lane the link was written against -- may be stale. */
  status: TaskStatus
}

/** The board card a project-relative path points at, or null if it is a plain file. */
export function parseProjectCardPath(relPath: string): ProjectCardRef | null {
  if (!relPath) return null
  const path = relPath.split('#')[0].split('?')[0]
  const m = CARD_PATH.exec(path)
  if (!m) return null
  return { status: m[1].toLowerCase() as TaskStatus, slug: m[2] }
}
