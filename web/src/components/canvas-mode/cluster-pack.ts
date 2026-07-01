// Geometry half of THE CANVAS layout: dagre lays out one project's cards
// top-down by spawn lineage, then clusters are shelf-packed into rows. Pure
// math, no React, no node-data -- layout.ts turns the result into React Flow
// nodes. Split out of layout.ts to keep each half under the size bar.
import Dagre from '@dagrejs/dagre'
import type { Conversation } from '@/lib/types'

export const NODE_W = 252
export const NODE_H = 96
export const EXPANDED_W = 540
export const EXPANDED_H = 520
export const SPACE_PAD = 40
export const TITLE_PAD = 76 // extra headroom so the painted project title clears row 1
const SPACE_GAP = 80
const ROW_MAX_W = 2600

export interface Cluster {
  uri: string
  members: Conversation[]
  positions: Map<string, { x: number; y: number }>
  w: number
  h: number
}

export function nodeSize(id: string, expandedIds: ReadonlySet<string>): { w: number; h: number } {
  return expandedIds.has(id) ? { w: EXPANDED_W, h: EXPANDED_H } : { w: NODE_W, h: NODE_H }
}

/** Dagre-layout one project's conversations (lineage edges only within it). */
export function layoutCluster(uri: string, members: Conversation[], expandedIds: ReadonlySet<string>): Cluster {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 56, marginx: 0, marginy: 0 })
  const memberIds = new Set(members.map(c => c.id))
  for (const c of members) {
    const { w, h } = nodeSize(c.id, expandedIds)
    g.setNode(c.id, { width: w, height: h })
  }
  for (const c of members) {
    if (c.parentConversationId && memberIds.has(c.parentConversationId)) g.setEdge(c.parentConversationId, c.id)
  }
  Dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  let maxX = 0
  let maxY = 0
  for (const c of members) {
    const p = g.node(c.id)
    const { w, h } = nodeSize(c.id, expandedIds)
    const x = p.x - w / 2
    const y = p.y - h / 2
    positions.set(c.id, { x, y })
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  return { uri, members, positions, w: maxX + SPACE_PAD * 2, h: maxY + SPACE_PAD + TITLE_PAD }
}

/** Shelf-pack clusters into rows of at most ROW_MAX_W, biggest first. */
export function packClusters(clusters: Cluster[]): Map<string, { x: number; y: number }> {
  const sorted = clusters.toSorted((a, b) => b.members.length - a.members.length || a.uri.localeCompare(b.uri))
  const origins = new Map<string, { x: number; y: number }>()
  let x = 0
  let y = 0
  let rowH = 0
  for (const c of sorted) {
    if (x > 0 && x + c.w > ROW_MAX_W) {
      x = 0
      y += rowH + SPACE_GAP
      rowH = 0
    }
    origins.set(c.uri, { x, y })
    x += c.w + SPACE_GAP
    rowH = Math.max(rowH, c.h)
  }
  return origins
}
