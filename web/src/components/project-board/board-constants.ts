/**
 * Board vocabulary shared by the columns, the card, the editor and the launcher.
 *
 * These lived at the top of project-board.tsx and were imported by nothing,
 * because everything that needed them lived in the same 1766-line file. Pulling
 * the components apart made the coupling visible; this is where it goes.
 */

import type { TaskStatus } from '@/hooks/use-project'

/** Coarse age of a card, for the corner of a card and the editor header. */
export function taskAge(created: string): string {
  if (!created) return ''
  const ms = Date.now() - new Date(created).getTime()
  if (ms < 0) return ''
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}

export const TASK_COLUMNS: { status: TaskStatus; label: string; color: string }[] = [
  { status: 'inbox', label: 'Inbox', color: 'text-event-prompt' },
  { status: 'open', label: 'Open', color: 'text-primary' },
  { status: 'in-progress', label: 'In Progress', color: 'text-accent' },
  { status: 'in-review', label: 'In Review', color: 'text-info' },
  { status: 'done', label: 'Done', color: 'text-active' },
]

/** Lane transitions. Absent key = no move in that direction. */
export const NEXT_STATUS: Record<string, TaskStatus> = {
  inbox: 'open',
  open: 'in-progress',
  'in-progress': 'in-review',
  'in-review': 'done',
}

export const PREV_STATUS: Record<string, TaskStatus> = {
  open: 'inbox',
  'in-progress': 'open',
  'in-review': 'in-progress',
  done: 'in-review',
}

const TAG_COLORS = [
  'bg-primary/20 text-primary border-primary/45',
  'bg-event-prompt/20 text-event-prompt border-event-prompt/45',
  'bg-info/20 text-info border-info/45',
  'bg-active/20 text-active border-active/45',
  'bg-accent/20 text-accent border-accent/45',
  'bg-destructive/20 text-destructive border-destructive/45',
]

/** Stable per-tag colour -- same tag is the same colour on every surface. */
export function tagColor(tag: string): string {
  let hash = 0
  for (const ch of tag) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

/**
 * Semantic tokens, not raw tailwind. `red-500`/`amber-500`/`blue-500` are not
 * the board's red, amber or blue -- they sat a few degrees off every other
 * colour on the same card, which is most of why the board read as muddy.
 */
export const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-destructive/20 text-destructive border-destructive/50',
  medium: 'bg-accent/20 text-accent border-accent/50',
  low: 'bg-info/15 text-info/80 border-info/40',
}

/**
 * THE BOARD'S CONTRAST FLOOR IS `text-fg-dim`. Enforced by
 * `scripts/lint-patterns.ts`; that rule's message carries the ladder.
 *
 * MEASURED, not eyeballed. Panel background is `oklch(0.15 0.02 260)` and
 * `--muted-foreground` is `oklch(0.7 0.02 260)`:
 *
 *   /25 -> 2.59   /35 -> 3.23   /40 -> 3.55   /50 -> 4.18
 *   /55 -> 4.50 (AA)   /60 -> 4.82   /70 -> 5.46   /85 -> 6.41
 *
 * Every string on this board is 9-13px, so it is SMALL text and owes 4.5:1 --
 * the 3:1 large-text allowance never applies here. The audit that produced this
 * found 44 of 63 usages below the floor, 19 of them `/40`, which is why the
 * board read as grey-on-grey no matter how many individual spots got nudged.
 *
 * Below the floor is legal ONLY for things that are not text -- rules, the
 * empty progress track, filler punctuation. Those are UI components under WCAG
 * 1.4.11 and owe 3:1, which is where `/35` comes from.
 */
/** The unselected state of a filter chip. One definition, because priority and
 *  tag chips drifting apart is how a filter row stops reading as one control. */
export const CHIP_IDLE = 'border-border text-fg-muted hover:text-foreground hover:border-border'

/** Column template for the epic child listing. Lives here rather than in either
 *  component because the header and the rows must agree, and having the row
 *  import it from the table made the two mutually circular. */
export const EPIC_CHILD_GRID = 'grid gap-2 grid-cols-[minmax(0,11rem)_minmax(0,1fr)_1rem_1.5rem_minmax(0,7rem)]'
