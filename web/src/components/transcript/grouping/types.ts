import type { TranscriptEntry } from '@/lib/types'

export interface TaskNotification {
  taskId: string
  summary: string
  status: 'completed' | 'failed' | 'killed' | string
  result?: string
  toolUseId?: string
  outputFile?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
}

export interface DisplayGroup {
  type:
    | 'user'
    | 'assistant'
    | 'system'
    | 'compacting'
    | 'compacted'
    | 'skill'
    | 'boot'
    | 'launch'
    | 'spawn_notification'
    | 'shell'
    /** Synthetic tail item that hosts the in-flight turn (streaming thinking +
     *  text + spinner + thinking-pill). Never produced by grouping; appended by
     *  TranscriptView so the live turn is a real measured virtualizer item that
     *  the committed assistant group takes over in place (same key/index). */
    | 'live'
    /** Synthetic HEAD item reserving estimated height for older entries not yet
     *  rendered (windowed-out or server-unloaded), so the scrollbar reflects the
     *  full conversation length. Prepended by TranscriptView; height in
     *  `spacerHeight`. Flag-gated (controlPanelPrefs.scrollbackReservation). */
    | 'scrollback_spacer'
  /** Stable React/virtualizer key, assigned by useIncrementalGroups and carried
   *  across regroups (tail-append, head-prune, refetch) so a group's DOM subtree
   *  is reused instead of remounted. A remount would give every DiffView/EditDiff
   *  a fresh mount -- useState reset + Shiki re-tokenize -- which `memo` can't
   *  prevent. Absent on batch-built groups (groupEntries), which key on array
   *  index; stableGroupKey falls back to the tail seq there. */
  id?: string
  timestamp: string
  entries: TranscriptEntry[]
  notifications?: TaskNotification[]
  localCommandOutput?: string
  systemSubtype?: string
  queued?: boolean
  skillName?: string
  planMode?: boolean
  /** scrollback_spacer only: estimated reserved height (px) + the count of
   *  unrendered older entries it stands in for. */
  spacerHeight?: number
  spacerCount?: number
}

/**
 * Mutable state passed through processEntry per pass. Both the batch
 * (groupEntries) and incremental (useIncrementalGroups) callers manage
 * their own instance of this shape and run the same per-entry logic over it.
 */
export interface GroupingState {
  groups: DisplayGroup[]
  current: DisplayGroup | null
  pendingSkillName: string | undefined
}
