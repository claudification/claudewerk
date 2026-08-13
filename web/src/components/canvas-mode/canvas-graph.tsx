// The pan/zoom graph itself: React Flow with conversation / project-space /
// sentinel / agent node types, hover-accentuated edges, and transient message
// pulses. Clicking a collapsed card expands it; dragging one pins it (hybrid
// manual layout). Sentinels, project spaces and agent satellites stay locked.
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag,
  ReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMemo, useState } from 'react'
import { AgentNode } from './agent-node'
import { AGENT_PINK, type ConversationCardData } from './canvas-types'
import { ConversationNode } from './conversation-node'
import { styleEdges } from './edge-style'
import type { CanvasNode } from './layout'
import { ProjectSpaceNode } from './project-space-node'
import { PulseEdge } from './pulse-edge'
import { SentinelNode } from './sentinel-node'
import { useMessagePulses } from './use-message-pulses'

const nodeTypes = {
  conversation: ConversationNode,
  projectSpace: ProjectSpaceNode,
  sentinel: SentinelNode,
  agent: AgentNode,
}
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
  agent: AGENT_PINK,
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
  onExpandConversation: (id: string) => void
  /** Pin a card's manual position when a drag finishes. */
  onPinConversation: (id: string, pos: { x: number; y: number }) => void
}

export function CanvasGraph({ nodes, edges, presentIds, onExpandConversation, onPinConversation }: CanvasGraphProps) {
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

  const handleNodeDragStop: OnNodeDrag<CanvasNode> = (_e, node) => {
    // Only conversation cards are draggable; pin where the user dropped it.
    if (node.type === 'conversation') onPinConversation(node.id, node.position)
  }

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No conversations to map.
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
      onNodeDragStop={handleNodeDragStop}
      onNodeMouseEnter={(_, node) => setHoveredId(node.type === 'projectSpace' ? null : node.id)}
      onNodeMouseLeave={() => setHoveredId(null)}
      colorMode="dark"
      nodesDraggable
      // a few px so a click still expands; only a real drag moves + pins a card
      nodeDragThreshold={4}
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
