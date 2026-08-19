/**
 * Board lane -> canonical card state. The whole backend-specific mapping, once.
 *
 * Two callers, and they must agree: the provider (answering "what state is this
 * card in" from the cache) and the tool-line card preview (answering the same
 * question from the bytes an agent just wrote). Deliberately NOT exported from
 * `index.ts` -- this is the project board's own vocabulary, and the seam above
 * it only ever speaks `CardState`.
 */

import type { TaskStatus } from '@shared/task-statuses'
import type { CardState } from './types'

export const BOARD_LANE_STATE: Record<TaskStatus, CardState> = {
  inbox: 'triage',
  open: 'todo',
  'in-progress': 'active',
  'in-review': 'review',
  done: 'done',
  archived: 'dropped',
}
