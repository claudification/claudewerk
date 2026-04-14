/**
 * Canonical task status definitions for the project board.
 * Single source of truth -- import from here everywhere.
 */

export const TASK_STATUSES = ['inbox', 'open', 'in-progress', 'in-review', 'done', 'archived'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Statuses shown by default (excludes done/archived) */
export const DEFAULT_VISIBLE_STATUSES: TaskStatus[] = ['inbox', 'open', 'in-progress', 'in-review']

/** Regex fragment matching any status folder name */
export const TASK_STATUS_PATTERN = TASK_STATUSES.join('|')
