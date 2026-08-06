/**
 * The global commit feed -- a flat CHRONOLOGICAL page plus the decorations the
 * browser needs to render group headers.
 *
 * Chronology is the spine; grouping is visual decluttering only, so the server
 * deliberately does NOT group. It returns rows newest-first with a cursor, and
 * the client collapses adjacent runs of the same (project, conversation). Group
 * on the server and the run-length headers stop being computable across page
 * boundaries -- the last group of page 1 and the first of page 2 would render as
 * two headers for one run.
 */

import type { CommitRow } from '../../shared/commit-ledger'
import type { ConversationStore } from '../conversation-store'

export interface ConversationDecoration {
  id: string
  name: string | null
  title?: string
  /** `active` | `idle` | `ended`, or `gone` when the conversation no longer
   *  exists -- the ledger outlives the conversations it describes, and a
   *  missing one is information, not an error. */
  status: string
  project: string | null
}

export interface ProjectDecoration {
  uri: string
  label: string
}

/** Last path segment, for a human-readable project label. Display only -- this
 *  is a label for a URI the broker already holds, never an identity derivation
 *  (CWD-IS-INFORMATIONAL: nothing branches on the result). */
function projectLabel(uri: string, fallback: string): string {
  const withoutFragment = uri.split('#')[0].replace(/\/+$/, '')
  const tail = withoutFragment.slice(withoutFragment.lastIndexOf('/') + 1)
  return tail || fallback || uri
}

export function decorateFeed(
  conversationStore: ConversationStore,
  rows: CommitRow[],
): { conversations: ConversationDecoration[]; projects: ProjectDecoration[] } {
  const conversations = new Map<string, ConversationDecoration>()
  const projects = new Map<string, ProjectDecoration>()

  for (const row of rows) {
    if (!projects.has(row.repoUri)) {
      projects.set(row.repoUri, { uri: row.repoUri, label: projectLabel(row.repoUri, row.repoName) })
    }
    const id = row.conversationId
    if (!id || conversations.has(id)) continue
    const conv = conversationStore.getConversation(id)
    conversations.set(id, {
      id,
      name: conv?.agentName ?? row.conversationName ?? null,
      title: conv?.title,
      status: conv?.status ?? 'gone',
      project: conv?.project ?? null,
    })
  }

  return { conversations: [...conversations.values()], projects: [...projects.values()] }
}

/** Cursor for the next (older) page: the oldest row's timestamp and id, so a
 *  burst of commits sharing one second cannot drop rows across the boundary. */
export function nextCursor(rows: CommitRow[]): string | null {
  const last = rows[rows.length - 1]
  return last ? `${last.committedAt}:${last.id}` : null
}

export function parseCursor(raw: string | null): { before: number; beforeId: number } | null {
  if (!raw) return null
  const [ts, id] = raw.split(':')
  const before = Number(ts)
  const beforeId = Number(id)
  if (!Number.isFinite(before) || !Number.isFinite(beforeId)) return null
  return { before, beforeId }
}
