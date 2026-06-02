import type { Conversation } from '@/lib/types'
import type { PoolSuggestion, ProfileSuggestion, SentinelSuggestion } from './use-spawn-mode'

export interface PaletteCommand {
  id: string
  label: string
  shortcut?: string
  shortcuts?: string[]
  action: () => void
}

export type PaletteMode = 'conversation' | 'command' | 'spawn' | 'task' | 'theme' | 'batch'

/** Merged result item for the no-prefix palette: conversations + pinned projects + commands fuzzy-matched together. */
export type MergedItem =
  | { kind: 'conversation'; conversation: Conversation; score: number; live: boolean }
  | { kind: 'project'; projectUri: string; score: number; live: boolean }
  | { kind: 'command'; command: PaletteCommand; score: number; live: boolean }

export interface CommandPaletteProps {
  onSelect: (conversationId: string) => void
  onClose: () => void
}

interface ResultListProps {
  activeIndex: number
  setActiveIndex: (i: number) => void
}

export interface ConversationResultsProps extends ResultListProps {
  conversations: Conversation[]
  selectedConversationId: string | null
  projectSettings: Record<string, { label?: string; icon?: string; color?: string; keyterms?: string[] }>
  onSelect: (conversationId: string) => void
}

export interface CommandResultsProps extends ResultListProps {
  commands: PaletteCommand[]
}

export interface SpawnResultsProps extends ResultListProps {
  dirs: string[]
  sentinels: SentinelSuggestion[]
  profiles: ProfileSuggestion[]
  pools: PoolSuggestion[]
  isSentinelEntry: boolean
  isProfileEntry: boolean
  isPoolEntry: boolean
  resolvedSentinel: string
  resolvedProfile: string
  resolvedPool: string
  loading: boolean
  error: string | null
  path: string
  spawning: boolean
  sentinelConnected: boolean
  canCreateDir: boolean
  onDirSelect: (dir: string) => void
  onSentinelSelect: (alias: string) => void
  onProfileSelect: (name: string) => void
  onPoolSelect: (name: string) => void
  onSpawn: (path: string, mkdir?: boolean) => void
}
