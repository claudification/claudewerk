// Edge building + styling for THE CANVAS. Spawn-lineage edges are built here
// tagged with data.kind ('lineage' | 'lineage-cross' | 'host'); styleEdges
// paints them and applies the hover accent: edges touching the hovered node
// light up, the rest fade back so a node's links pop out. Pure -- no React.
import type { Edge } from '@xyflow/react'
import type { Conversation } from '@/lib/types'

/** Spawn-lineage edges parent -> child, tagged cross-project when they leave
 *  the parent's space (drawn dashed). Parents not on the canvas are skipped. */
export function buildLineageEdges(conversations: Conversation[], byProject: Map<string, Conversation[]>): Edge[] {
  const projectOf = new Map<string, string>()
  for (const [uri, members] of byProject) for (const c of members) projectOf.set(c.id, uri)
  const edges: Edge[] = []
  for (const c of conversations) {
    const parent = c.parentConversationId
    if (!parent || !projectOf.has(parent)) continue
    const crossProject = projectOf.get(parent) !== projectOf.get(c.id)
    edges.push({
      id: `${parent}->${c.id}`,
      source: parent,
      target: c.id,
      animated: c.status === 'active',
      data: { kind: crossProject ? 'lineage-cross' : 'lineage' },
    })
  }
  return edges
}

type EdgeKind = 'lineage' | 'lineage-cross' | 'host'

import type { CSSProperties } from 'react'

type EdgePaint = CSSProperties & {
  stroke: string
  strokeWidth: number
  opacity: number
  strokeDasharray?: string
}

const BASE: Record<EdgeKind, EdgePaint> = {
  lineage: { stroke: 'var(--color-border)', strokeWidth: 1.5, opacity: 0.9 },
  'lineage-cross': { stroke: 'var(--color-border)', strokeWidth: 1.5, opacity: 0.9, strokeDasharray: '6 5' },
  host: { stroke: 'var(--color-border)', strokeWidth: 1, opacity: 0.14, strokeDasharray: '2 5' },
}

const ACCENT: Record<EdgeKind, EdgePaint> = {
  lineage: { stroke: 'var(--color-active)', strokeWidth: 2.5, opacity: 1 },
  'lineage-cross': { stroke: 'var(--color-active)', strokeWidth: 2.5, opacity: 1, strokeDasharray: '6 5' },
  host: { stroke: 'var(--color-info)', strokeWidth: 2, opacity: 0.95, strokeDasharray: '2 5' },
}

const DIMMED_OPACITY = 0.05

function edgeKind(edge: Edge): EdgeKind {
  return (edge.data?.kind as EdgeKind | undefined) ?? 'lineage'
}

function touchesNode(edge: Edge, hoveredId: string | null): boolean {
  return hoveredId !== null && (edge.source === hoveredId || edge.target === hoveredId)
}

function paint(edge: Edge, hoveredId: string | null): EdgePaint {
  const palette = touchesNode(edge, hoveredId) ? ACCENT[edgeKind(edge)] : BASE[edgeKind(edge)]
  const dimmed = hoveredId !== null && !touchesNode(edge, hoveredId)
  return dimmed ? { ...palette, opacity: DIMMED_OPACITY } : palette
}

function styleEdge(edge: Edge, hoveredId: string | null): Edge {
  return { ...edge, zIndex: touchesNode(edge, hoveredId) ? 5 : 0, style: paint(edge, hoveredId) }
}

/** Paint base styles, then apply hover accent/dim relative to `hoveredId`. */
export function styleEdges(edges: Edge[], hoveredId: string | null): Edge[] {
  return edges.map(edge => styleEdge(edge, hoveredId))
}
