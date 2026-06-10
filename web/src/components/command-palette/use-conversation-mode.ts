import { projectIdentityKey } from '@shared/project-uri'
import { Fzf } from 'fzf'
import { useMemo } from 'react'
import { useConversations, useConversationsStore } from '@/hooks/use-conversations'
import { getFrequencyMap } from '@/lib/conversation-frequency'
import { type Conversation, projectPath } from '@/lib/types'
import type { MergedItem } from './types'
import type { RegistryCommand } from './use-command-mode'

export interface ConversationModeState {
  allConversations: Conversation[]
  mergedItems: MergedItem[]
  filteredConversations: Conversation[]
}

/**
 * Conversation-mode (no prefix) derivations. Sorts the conversation list (MRU top 2 +
 * frequency-weighted), runs Fzf over both conversations and the registry commands.
 * Filtered ranking blends fzf score with multiplicative boosts for MRU (+50% top),
 * project frequency (+30% hottest), and liveness (+30%). Liveness is a soft nudge,
 * not a hard partition -- a strong match on an ended conversation beats a weak
 * match on a live one. Commands carry a 0.5 score penalty to sit below conversations.
 */
export function useConversationMode(
  filter: string,
  isConversationMode: boolean,
  registryCommands: RegistryCommand[],
): ConversationModeState {
  const conversations = useConversations()
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const conversationMru = useConversationsStore(state => state.conversationMru)
  const projectSettings = useConversationsStore(state => state.projectSettings)

  const freqMap = useMemo(() => getFrequencyMap(), [])

  const mruIndex = useMemo(() => new Map(conversationMru.map((id, i) => [id, i])), [conversationMru])

  const maxFreq = useMemo(() => {
    let m = 0
    for (const k in freqMap) {
      const c = freqMap[k]?.count || 0
      if (c > m) m = c
    }
    return Math.max(1, m)
  }, [freqMap])

  const allConversations = useMemo(
    () => sortConversationsForPalette(conversations, mruIndex, freqMap),
    [conversations, mruIndex, freqMap],
  )

  // Field-weighted selector: repetition inflates per-field weight in fzf's
  // single-pass scoring. Title 3x > label 2x > path/recap/agent/idSuffix 1x.
  // status/model removed (they polluted the corpus -- "running"/"sonnet" matched all).
  // Id is last 8 chars only -- partial-id matches need intent.
  const conversationFzf = useMemo(
    () =>
      new Fzf(allConversations, {
        selector: (s: Conversation) => {
          const ps = projectSettings[projectIdentityKey(s.project)]
          const title = s.title || ''
          const label = ps?.label || ''
          const path = projectPath(s.project)
          const recap = s.recap?.title || ''
          const agent = s.agentName || ''
          const idSuffix = s.id.slice(-8)
          return `${title} ${title} ${title} ${label} ${label} ${path} ${recap} ${agent} ${idSuffix}`
        },
        casing: 'case-insensitive',
      }),
    [allConversations, projectSettings],
  )

  const paletteCommandFzf = useMemo(
    () => new Fzf(registryCommands, { selector: c => `${c.label} ${c.id}`, casing: 'case-insensitive' }),
    [registryCommands],
  )

  // Pinned projects (the projectSettings key is a normalized project URI, directly
  // usable as a selectProject() argument -- see PinnedProjectNode). All pinned
  // projects surface, even ones that already have active conversation rows.
  const pinnedProjectUris = useMemo(() => {
    const out: string[] = []
    for (const [uri, ps] of Object.entries(projectSettings)) {
      if (ps.pinned) out.push(uri)
    }
    return out
  }, [projectSettings])

  const projectFzf = useMemo(
    () =>
      new Fzf(pinnedProjectUris, {
        selector: (uri: string) => {
          const ps = projectSettings[projectIdentityKey(uri)]
          const label = ps?.label || ''
          const path = projectPath(uri)
          return `${label} ${label} ${path}`
        },
        casing: 'case-insensitive',
      }),
    [pinnedProjectUris, projectSettings],
  )

  const conversationSearchResults = useMemo(() => {
    if (!isConversationMode || !filter) return []
    return conversationFzf.find(filter).map(r => {
      const conv = r.item
      // Multiplicative boosts on fzf score. Live is a soft +30% nudge (NOT a hard partition),
      // so a strong match on an ended conv beats a weak match on a live one.
      const mi = mruIndex.get(conv.id) ?? -1
      const mruBoost = mi < 0 ? 0 : 1 / (1 + mi) // top=1, 2nd=0.5, 3rd=0.33...
      const freqBoost = (freqMap[conv.project]?.count || 0) / maxFreq // 0..1
      const liveBoost = conv.status !== 'ended' ? 1 : 0
      const multiplier = 1 + 0.5 * mruBoost + 0.3 * freqBoost + 0.3 * liveBoost
      return {
        kind: 'conversation' as const,
        conversation: conv,
        score: r.score * multiplier,
        live: conv.status !== 'ended',
      }
    })
  }, [isConversationMode, filter, conversationFzf, mruIndex, freqMap, maxFreq])

  const commandSearchResults = useMemo(() => {
    if (!isConversationMode || !filter) return []
    // Penalty keeps commands below equally-scored conversations
    const COMMAND_SCORE_PENALTY = 0.5
    return paletteCommandFzf.find(filter).map(r => ({
      kind: 'command' as const,
      command: r.item,
      score: r.score * COMMAND_SCORE_PENALTY,
      live: false,
    }))
  }, [isConversationMode, filter, paletteCommandFzf])

  const projectSearchResults = useMemo(() => {
    if (!isConversationMode || !filter) return []
    // Plain fzf score: a matching pinned project sits above commands (which carry a
    // penalty) but below a live conversation with an equally strong match (which gets boosts).
    return projectFzf.find(filter).map(r => ({
      kind: 'project' as const,
      projectUri: r.item,
      score: r.score,
      live: false,
    }))
  }, [isConversationMode, filter, projectFzf])

  const mergedItems: MergedItem[] = useMemo(() => {
    if (!isConversationMode) return []
    if (!filter) {
      const convItems: MergedItem[] = []
      for (const s of allConversations) {
        if (s.status === 'ended' || s.id === selectedConversationId) continue
        convItems.push({ kind: 'conversation' as const, conversation: s, score: 0, live: true })
      }
      const projItems: MergedItem[] = pinnedProjectUris.map(uri => ({
        kind: 'project' as const,
        projectUri: uri,
        score: 0,
        live: false,
      }))
      return [...convItems, ...projItems]
    }
    const merged: MergedItem[] = [...conversationSearchResults, ...projectSearchResults, ...commandSearchResults]
    merged.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // Stable tiebreaker: MRU asc, then lastActivity desc
      const am =
        a.kind === 'conversation'
          ? (mruIndex.get(a.conversation.id) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER
      const bm =
        b.kind === 'conversation'
          ? (mruIndex.get(b.conversation.id) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER
      if (am !== bm) return am - bm
      const at = a.kind === 'conversation' ? a.conversation.lastActivity : 0
      const bt = b.kind === 'conversation' ? b.conversation.lastActivity : 0
      return bt - at
    })
    return merged
  }, [
    isConversationMode,
    filter,
    allConversations,
    selectedConversationId,
    pinnedProjectUris,
    conversationSearchResults,
    projectSearchResults,
    commandSearchResults,
    mruIndex,
  ])

  const filteredConversations = useMemo(() => {
    const out: Conversation[] = []
    for (const i of mergedItems) {
      if (i.kind === 'conversation') out.push(i.conversation)
    }
    return out
  }, [mergedItems])

  return { allConversations, mergedItems, filteredConversations }
}

function sortConversationsForPalette(
  conversations: Conversation[],
  mruIndex: Map<string, number>,
  freqMap: Record<string, { count: number }>,
): Conversation[] {
  const activeProjects = new Set<string>()
  for (const s of conversations) {
    if (s.status !== 'ended') activeProjects.add(s.project)
  }
  const deduplicated = conversations.filter(s => s.status !== 'ended' || !activeProjects.has(s.project))
  return deduplicated.toSorted((a, b) => {
    const ai = mruIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const bi = mruIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER
    // Top 2 MRU spots are sacred (alt-tab behavior)
    const aTop = ai < 2
    const bTop = bi < 2
    if (aTop !== bTop) return aTop ? -1 : 1
    if (aTop && bTop) return ai - bi
    // Rest sorted by frequency (descending), then recency as tiebreaker
    const af = freqMap[a.project]?.count || 0
    const bf = freqMap[b.project]?.count || 0
    if (af !== bf) return bf - af
    return b.lastActivity - a.lastActivity
  })
}
