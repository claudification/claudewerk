/**
 * Batch-mode conversation filtering.
 *
 * THE LABEL RULE: every user-facing surface names a project by its DISPLAY
 * LABEL (`Scratch/Temp`, `CLAUDEWERK`), never by the `claude://` URI it is
 * stored under (`.../Users/jonas/temp`, `.../projects/remote-claude`). The
 * project filter used to test the raw URI only, so typing the only name the
 * user has ever seen matched nothing and the project looked absent from batch
 * entirely. Both the URI and the label are searchable now; the URI stays
 * matchable so a path fragment still works.
 */

import type { Conversation, ProjectSettings } from '@/lib/types'
import { projectLabelFor } from './batch-grouping'

export interface FilterState {
  project: string
  status: 'any' | 'live' | 'idle'
  sentinel: string
  text: string
}

type Settings = Record<string, ProjectSettings>

function matchesStatus(c: Conversation, filter: FilterState): boolean {
  // Ended conversations are never batch-selectable. No toggle reinstates them.
  if (c.status === 'ended') return false
  if (filter.status === 'any') return true
  if (filter.status === 'live') return c.status === 'active'
  return c.status === 'idle'
}

function matchesSentinel(c: Conversation, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    (c.hostSentinelId ?? '').toLowerCase().includes(needle) ||
    (c.hostSentinelAlias ?? '').toLowerCase().includes(needle)
  )
}

/** Raw project URI + the label the user actually sees, both lowercased. */
function projectHaystack(c: Conversation, settings: Settings): string {
  return `${c.project} ${projectLabelFor(c, settings)}`.toLowerCase()
}

function matchesProject(c: Conversation, q: string, settings: Settings): boolean {
  if (!q) return true
  return projectHaystack(c, settings).includes(q.toLowerCase())
}

function matchesText(c: Conversation, q: string, settings: Settings): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (c.title ?? '').toLowerCase().includes(needle) || projectHaystack(c, settings).includes(needle)
}

export function filterConversations(
  conversations: Conversation[],
  filter: FilterState,
  settings: Settings,
): Conversation[] {
  return conversations.filter(
    c =>
      matchesProject(c, filter.project, settings) &&
      matchesStatus(c, filter) &&
      matchesSentinel(c, filter.sentinel) &&
      matchesText(c, filter.text, settings),
  )
}
