import { Fzf } from 'fzf'
import { useMemo } from 'react'
import { useConversations, useConversationsStore } from '@/hooks/use-conversations'
import { getFrequencyMap } from '@/lib/conversation-frequency'
import type { Conversation } from '@/lib/types'
import { compareMergedItems, RANK_TIER, sortConversationsForPalette } from './conversation-ranking'
import type { MergedItem } from './types'
import type { RegistryCommand } from './use-command-mode'
import { useConversationSearch } from './use-conversation-search'
import { useProjectSearch } from './use-project-search'

export interface ConversationModeState {
  allConversations: Conversation[]
  mergedItems: MergedItem[]
  filteredConversations: Conversation[]
}

/**
 * Conversation-mode (no prefix) derivations. Results are partitioned into hard tiers
 * (see RANK_TIER): a direct conversation-name match (T1) outranks active conversations of
 * a name-matched project (T2, by start time), which outrank a bare project node when that
 * project has no active conversations (T3), which outranks weak/fuzzy matches and commands
 * (T4). Searching "minecraft" lands the minecraft project/conversations far above any
 * conversation that merely fuzzy-matches those letters. The heavy lifting lives in
 * useConversationSearch + useProjectSearch; this hook just merges and sorts.
 */
// react-doctor-disable-next-line react-doctor/no-derived-state -- all derivations use useMemo, no useState+useEffect sync
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
  const mruIndex = useMemo(() => new Map(conversationMru.map((e, i) => [e.id, i])), [conversationMru])
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

  const conversationSearchResults = useConversationSearch({
    filter,
    isConversationMode,
    allConversations,
    projectSettings,
    mruIndex,
    freqMap,
    maxFreq,
  })
  const { pinnedProjectUris, projectSearchResults } = useProjectSearch(
    filter,
    isConversationMode,
    conversations,
    projectSettings,
  )

  const paletteCommandFzf = useMemo(
    () => new Fzf(registryCommands, { selector: c => `${c.label} ${c.id}`, casing: 'case-insensitive' }),
    [registryCommands],
  )

  const commandSearchResults = useMemo<MergedItem[]>(() => {
    if (!isConversationMode || !filter) return []
    const COMMAND_SCORE_PENALTY = 0.5 // keep commands below the conversation/project tiers
    return paletteCommandFzf.find(filter).map(r => ({
      kind: 'command' as const,
      command: r.item,
      tier: RANK_TIER.FUZZY,
      score: r.score * COMMAND_SCORE_PENALTY,
      live: false,
    }))
  }, [isConversationMode, filter, paletteCommandFzf])

  const mergedItems: MergedItem[] = useMemo(() => {
    if (!isConversationMode) return []
    if (!filter) return emptyFilterItems(allConversations, pinnedProjectUris, selectedConversationId)
    const merged = [...conversationSearchResults, ...projectSearchResults, ...commandSearchResults]
    merged.sort((a, b) => compareMergedItems(a, b, mruIndex))
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

/** Unfiltered palette: live conversations (minus the current one) followed by pinned projects. */
function emptyFilterItems(
  allConversations: Conversation[],
  pinnedProjectUris: string[],
  selectedConversationId: string | null,
): MergedItem[] {
  const convItems: MergedItem[] = allConversations.flatMap(s =>
    s.status !== 'ended' && s.id !== selectedConversationId
      ? [{ kind: 'conversation' as const, conversation: s, tier: RANK_TIER.FUZZY, score: 0, live: true }]
      : [],
  )
  const projItems: MergedItem[] = pinnedProjectUris.map(uri => ({
    kind: 'project',
    projectUri: uri,
    tier: RANK_TIER.FUZZY,
    score: 0,
    live: false,
  }))
  return [...convItems, ...projItems]
}
