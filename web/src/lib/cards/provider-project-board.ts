/**
 * CardProvider for the file-based project board (`.rclaude/project/cards/*.md`).
 *
 * The board is ambient: a card link in a transcript is relative to the SELECTED
 * conversation's project, so `matchHref` stamps that project URI into the ref's
 * `scope`. A future GitHub/Linear provider carries its own scope (repo, team)
 * the same way and nothing above the seam changes.
 *
 * Two-tier resolution mirrors the cache: the manifest answers "which lane" for
 * free, meta answers "what does it say", and only an epic pays for a full board
 * hydration (its progress is a fold over children, which declare the parent).
 */

import { EPIC_TAG } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'
import type { TaskStatus } from '@shared/task-statuses'
import {
  boardVersion,
  ensureProjectCard,
  hydrateProjectBoard,
  isBoardHydrated,
  peekProjectCard,
  peekProjectMeta,
} from '@/hooks/project-card-lookup'
import { subscribeProjectCache } from '@/hooks/project-task-cache'
import { useConversationsStore } from '@/hooks/use-conversations'
import { parseProjectCardPath } from '@/lib/project-card-link'
import { CARD_PROGRESS_BUCKET } from './state-style'
import type { CardLookup, CardProgress, CardProvider, CardRef, CardState, CardSummary } from './types'

const PROJECT_BOARD_PROVIDER = 'project-board'

/** Board lane -> canonical state. The whole backend-specific mapping, in one table. */
const STATE_BY_LANE: Record<TaskStatus, CardState> = {
  inbox: 'triage',
  open: 'todo',
  'in-progress': 'active',
  'in-review': 'review',
  done: 'done',
  archived: 'dropped',
}

/** The project the panel is currently looking at. Null when nothing is selected. */
function ambientProject(): string | null {
  const state = useConversationsStore.getState()
  const conv = state.selectedConversationId ? state.conversationsById[state.selectedConversationId] : null
  return conv?.project ?? null
}

function childrenOf(scope: string, id: string): ProjectTaskMeta[] {
  return peekProjectMeta(scope).filter(m => m.epic === id)
}

function rollUp(children: ProjectTaskMeta[]): CardProgress {
  const counts = { todo: 0, active: 0, done: 0, dropped: 0 }
  for (const child of children) counts[CARD_PROGRESS_BUCKET[STATE_BY_LANE[child.status]]]++
  const total = children.length - counts.dropped
  return { ...counts, total, pct: total > 0 ? Math.round((counts.done / total) * 100) : null }
}

const progressMemo = new Map<string, { version: number; progress: CardProgress }>()

function progressFor(scope: string, id: string): CardProgress | undefined {
  if (!isBoardHydrated(scope)) return undefined
  const version = boardVersion(scope)
  const key = `${scope}:${id}`
  const hit = progressMemo.get(key)
  if (hit && hit.version === version) return hit.progress
  const progress = rollUp(childrenOf(scope, id))
  progressMemo.set(key, { version, progress })
  return progress
}

function isEpic(scope: string, meta: ProjectTaskMeta): boolean {
  if (meta.tags.includes(EPIC_TAG)) return true
  return isBoardHydrated(scope) && childrenOf(scope, meta.slug).length > 0
}

function fullSummary(ref: CardRef, scope: string, meta: ProjectTaskMeta): CardSummary {
  const epic = isEpic(scope, meta)
  return {
    ref,
    kind: epic ? 'epic' : 'card',
    state: STATE_BY_LANE[meta.status],
    statusLabel: meta.status,
    detail: 'full',
    title: meta.title,
    priority: meta.priority,
    tags: meta.tags,
    created: meta.created,
    updated: meta.mtime,
    progress: epic ? progressFor(scope, meta.slug) : undefined,
  }
}

export const projectBoardProvider: CardProvider = {
  id: PROJECT_BOARD_PROVIDER,

  matchHref(href) {
    const card = parseProjectCardPath(href)
    if (!card) return null
    return { provider: PROJECT_BOARD_PROVIDER, id: card.id, scope: ambientProject() ?? undefined }
  },

  peek(ref): CardLookup {
    if (!ref.scope) return { status: 'unavailable' }
    const { manifestFetched, entry, meta } = peekProjectCard(ref.scope, ref.id)
    if (!entry) return manifestFetched ? { status: 'unknown' } : { status: 'resolving' }
    if (meta) return { status: 'ready', summary: fullSummary(ref, ref.scope, meta) }
    return {
      status: 'ready',
      summary: {
        ref,
        kind: 'card',
        state: STATE_BY_LANE[entry.status],
        statusLabel: entry.status,
        detail: 'partial',
        tags: [],
        updated: entry.mtime,
      },
    }
  },

  resolve(ref) {
    if (ref.scope) ensureProjectCard(ref.scope, ref.id)
  },

  resolveDeep(ref) {
    if (ref.scope) hydrateProjectBoard(ref.scope)
  },

  // The scope is ambient, so the subscription follows it: selecting a
  // conversation in another project rebinds to that project's cache and pings
  // the listener, instead of quietly reporting the old board forever.
  subscribe(fn) {
    let scope = ambientProject()
    let offCache = scope ? subscribeProjectCache(scope, fn) : () => {}
    const offStore = useConversationsStore.subscribe(() => {
      const next = ambientProject()
      if (next === scope) return
      offCache()
      scope = next
      offCache = scope ? subscribeProjectCache(scope, fn) : () => {}
      fn()
    })
    return () => {
      offCache()
      offStore()
    }
  },
}
