// The pan/zoom graph itself: React Flow with conversation / project-space /
// sentinel node types, hover-accentuated edges, and transient message pulses.
// Read-only topology -- nodes aren't draggable; clicking a card expands it.
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  ReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMemo, useState } from 'react'
import type { ConversationCardData } from './canvas-types'
import { ConversationNode } from './conversation-node'
import { styleEdges } from './edge-style'
import type { CanvasNode } from './layout'
import { ProjectSpaceNode } from './project-space-node'
import { PulseEdge } from './pulse-edge'
import { SentinelNode } from './sentinel-node'
import { useMessagePulses } from './use-message-pulses'

const nodeTypes = { conversation: ConversationNode, projectSpace: ProjectSpaceNode, sentinel: SentinelNode }
const edgeTypes = { pulse: PulseEdge }

const MINIMAP_STATUS_COLORS: Record<string, string> = {
  active: 'var(--color-active)',
  idle: 'var(--color-idle)',
  starting: 'var(--color-info)',
  booting: 'var(--color-info)',
  ended: 'var(--color-ended)',
}

const MINIMAP_TYPE_COLORS: Record<string, string> = {
  projectSpace: 'oklch(0.4 0.02 260 / 0.3)',
  sentinel: 'oklch(0.6 0.1 250 / 0.6)',
}

function minimapColor(n: Node): string {
  const byType = MINIMAP_TYPE_COLORS[n.type as string]
  if (byType) return byType
  const status = String((n.data as ConversationCardData).status)
  return MINIMAP_STATUS_COLORS[status] || 'var(--color-ended)'
}

interface CanvasGraphProps {
  nodes: CanvasNode[]
  edges: Edge[]
  presentIds: ReadonlySet<string>
  showEnded: boolean
  onExpandConversation: (id: string) => void
}

export function CanvasGraph({ nodes, edges, presentIds, showEnded, onExpandConversation }: CanvasGraphProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const pulses = useMessagePulses(presentIds)

  const styledEdges = useMemo(() => [...styleEdges(edges, hoveredId), ...pulses], [edges, hoveredId, pulses])

  function handleNodeClick(...[, node]: Parameters<NodeMouseHandler>) {
    // Click expands a collapsed card; expanded cards collapse via their own
    // button (clicks inside them select text / hit controls instead).
    if (node.type === 'conversation' && !(node.data as ConversationCardData).expanded) {
      onExpandConversation(node.id)
    }
  }

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No conversations to map{showEnded ? '' : ' (ended hidden)'}.
      </div>
    )
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={styledEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={handleNodeClick}
      onNodeMouseEnter={(_, node) => setHoveredId(node.type === 'projectSpace' ? null : node.id)}
      onNodeMouseLeave={() => setHoveredId(null)}
      colorMode="dark"
      nodesDraggable={false}
      nodesConnectable={false}
      fitView
      minZoom={0.1}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={22} size={1} variant={BackgroundVariant.Dots} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        className="!bg-card"
        maskColor="rgba(0,0,0,0.4)"
        nodeColor={minimapColor}
        nodeStrokeWidth={0}
      />
    </ReactFlow>
  )
}
