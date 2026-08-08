import { useEffect, useMemo, useState } from 'react'
import { useConversationStructure, useConversationsStore, wsSend } from '@/hooks/use-conversations'
import type { ProjectOrder } from './use-project-groups'

const EMPTY_ORDER: ProjectOrder = { tree: [] }

/**
 * Every store read and side effect the sidebar list needs, in one place.
 *
 * Each field is its own selector on purpose -- one selector returning an object
 * literal would allocate a fresh object per store tick and loop forever
 * (React #185). Grouping them here is about keeping `ProjectList` a renderer,
 * not about collapsing the subscriptions.
 */
export function useProjectListStore() {
  // Structural shape only (id+project+status+capabilities+startedAt). Per-row
  // field churn -- tokens, recap, stats, gitBranch, streaming text -- must NOT
  // re-render the whole list; leaf rows subscribe to their own conversation by
  // id. lastActivity is excluded for the same reason: it changes on every WS
  // message and is only needed for sorting ended rows, where it is read lazily
  // from the store at sort time.
  const structure = useConversationStructure()
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const rawProjectOrder = useConversationsStore(s => s.projectOrder)
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const showEnded = useConversationsStore(s => s.controlPanelPrefs.showEndedConversations)
  const showInactive = useConversationsStore(s => s.controlPanelPrefs.showInactiveByDefault)
  const activeWorkspaceId = useConversationsStore(s => s.controlPanelPrefs.activeWorkspaceId)
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)

  // Guards on `.tree` specifically, not just on the object: a partially-hydrated
  // projectOrder with no tree would otherwise crash every consumer downstream.
  const projectOrder = useMemo<ProjectOrder>(
    () => (rawProjectOrder?.tree ? rawProjectOrder : EMPTY_ORDER),
    [rawProjectOrder],
  )

  useRosterReplay()
  useMinuteTick()

  return {
    structure,
    selectedConversationId,
    projectOrder,
    projectSettings,
    showEnded,
    showInactive,
    activeWorkspaceId,
    updatePrefs,
  }
}

/**
 * Ask the broker to replay the cached daemon roster on mount and on every
 * reconnect, so ghost rows (discovered but unattached daemon workers) light up
 * immediately instead of waiting out a 10s sentinel poll. Subscribes to
 * connectSeq only -- the roster data itself is read per-row by useGhostShort.
 */
function useRosterReplay() {
  const connectSeq = useConversationsStore(s => s.connectSeq)
  useEffect(() => {
    wsSend('daemon_roster_request')
  }, [connectSeq])
}

/** Re-render twice a minute so the relative timestamps on each row stay honest. */
function useMinuteTick() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
}
