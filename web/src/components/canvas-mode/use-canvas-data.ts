// Live data feed for THE CANVAS: selects conversations + sentinels from the
// store (already permission-filtered server-side), applies the ended filter,
// and memoizes the dagre layout + sentinel column on input identity.
import type { Edge } from '@xyflow/react'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { selectConversations } from '@/lib/slim-conversation'
import { type CanvasNode, layoutCanvas } from './layout'
import { buildSentinelEdges, buildSentinelNodes } from './sentinels'

export interface CanvasData {
  nodes: CanvasNode[]
  edges: Edge[]
  /** Conversation ids on the canvas -- pulse endpoints must both exist. */
  presentIds: ReadonlySet<string>
  total: number
  activeCount: number
}

export function useCanvasData(showEnded: boolean, expandedIds: ReadonlySet<string>): CanvasData {
  const byId = useConversationsStore(s => s.conversationsById)
  const selectedId = useConversationsStore(s => s.selectedConversationId)
  const sentinels = useConversationsStore(s => s.sentinels)
  const profileUsage = useConversationsStore(s => s.profileUsage)

  return useMemo(() => {
    const all = selectConversations(byId)
    // Expanded cards stay visible even if they end mid-session.
    const visible = showEnded ? all : all.filter(c => c.status !== 'ended' || expandedIds.has(c.id))
    const { nodes, edges } = layoutCanvas(visible, selectedId, Date.now(), expandedIds)
    return {
      nodes: [...nodes, ...buildSentinelNodes(sentinels, visible, profileUsage)],
      edges: [...edges, ...buildSentinelEdges(sentinels, visible)],
      presentIds: new Set(visible.map(c => c.id)),
      total: visible.length,
      activeCount: visible.filter(c => c.status === 'active').length,
    }
  }, [byId, selectedId, showEnded, expandedIds, sentinels, profileUsage])
}
