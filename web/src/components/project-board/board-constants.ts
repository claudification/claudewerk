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
  'bg-primary/20 text-primary border-primary/30',
  'bg-event-prompt/20 text-event-prompt border-event-prompt/30',
  'bg-info/20 text-info border-info/30',
  'bg-active/20 text-active border-active/30',
  'bg-accent/20 text-accent border-accent/30',
  'bg-destructive/20 text-destructive border-destructive/30',
]

/** Stable per-tag colour -- same tag is the same colour on every surface. */
export function tagColor(tag: string): string {
  let hash = 0
  for (const ch of tag) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

export const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-red-500/20 text-red-400 border-red-500/30',
  medium: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
}
