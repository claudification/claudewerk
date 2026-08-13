// Live data feed for THE CANVAS: selects conversations + sentinels from the
// store (already permission-filtered server-side), drops ended conversations,
// and memoizes the dagre layout + sentinel rail + pink agent overlay. The dagre
// pass (expensive) memoizes on real input changes; the agent overlay (cheap)
// recomputes on the decay tick so just-stopped agents fade out on schedule.
import type { Edge } from '@xyflow/react'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { selectConversations } from '@/lib/slim-conversation'
import { buildAgentNodes } from './agents'
import { type CanvasNode, layoutCanvas } from './layout'
import { buildSentinelEdges, buildSentinelNodes } from './sentinels'
import { useAgentDecay } from './use-agent-decay'
import type { LayoutOverrides } from './use-layout-overrides'

export interface CanvasData {
  nodes: CanvasNode[]
  edges: Edge[]
  /** Conversation ids on the canvas -- pulse endpoints must both exist. */
  presentIds: ReadonlySet<string>
  total: number
  activeCount: number
}

export function useCanvasData(expandedIds: ReadonlySet<string>, overrides: LayoutOverrides): CanvasData {
  const byId = useConversationsStore(s => s.conversationsById)
  const selectedId = useConversationsStore(s => s.selectedConversationId)
  const sentinels = useConversationsStore(s => s.sentinels)
  const profileUsage = useConversationsStore(s => s.profileUsage)

  // Expensive dagre pass -- only when the real inputs change.
  const base = useMemo(() => {
    const all = selectConversations(byId)
    // Ended conversations never appear -- there is no toggle. The one carve-out
    // is a card the user already expanded that ends mid-session: yanking it out
    // from under them mid-read would be worse than letting it sit until closed.
    const visible = all.filter(c => c.status !== 'ended' || expandedIds.has(c.id))
    const { nodes, edges, cardRects } = layoutCanvas(visible, selectedId, Date.now(), expandedIds, overrides)
    return { nodes, edges, cardRects, visible }
  }, [byId, selectedId, expandedIds, overrides])

  // `now` advances when a stopped agent's linger expires -> re-run the overlay.
  const now = useAgentDecay(base.visible)

  return useMemo(() => {
    const agents = buildAgentNodes(base.visible, base.cardRects, now)
    return {
      nodes: [
        ...base.nodes,
        ...buildSentinelNodes(sentinels, base.visible, profileUsage, base.cardRects),
        ...agents.nodes,
      ],
      edges: [...base.edges, ...buildSentinelEdges(sentinels, base.visible), ...agents.edges],
      presentIds: new Set(base.visible.map(c => c.id)),
      total: base.visible.length,
      activeCount: base.visible.filter(c => c.status === 'active').length,
    }
  }, [base, sentinels, profileUsage, now])
}
