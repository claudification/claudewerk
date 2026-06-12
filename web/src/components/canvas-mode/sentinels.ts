// Sentinel nodes for THE CANVAS: one node per sentinel (status + per-profile
// usage), stacked in a column LEFT of the project spaces, plus faint host
// edges sentinel -> every conversation it hosts. Pure -- no React.

import type { ProfileUsageSnapshot } from '@shared/protocol'
import type { Edge, Node } from '@xyflow/react'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import type { SentinelNodeData, SentinelProfileRow } from './canvas-types'

const SENTINEL_W = 280
const SENTINEL_BASE_H = 72
const SENTINEL_PROFILE_H = 40
const SENTINEL_GAP = 48
const SENTINEL_COL_X = -(SENTINEL_W + 160)

export type ProfileUsageMap = Record<string, ProfileUsageSnapshot & { sentinelId: string; polledAt: number }>

function sentinelNodeId(sentinelId: string): string {
  return `sentinel:${sentinelId}`
}

function sentinelNodeHeight(profileCount: number): number {
  return SENTINEL_BASE_H + profileCount * SENTINEL_PROFILE_H
}

function profileRows(s: SentinelStatusInfo, usage: ProfileUsageMap): SentinelProfileRow[] {
  return (s.profiles ?? []).map(p => {
    const snap = usage[`${s.sentinelId}/${p.name}`]
    return {
      name: p.label || p.name,
      pool: p.pool ?? undefined,
      authed: snap?.authed ?? false,
      fiveHourPct: snap?.fiveHour?.usedPercent,
      sevenDayPct: snap?.sevenDay?.usedPercent,
      error: snap?.error?.kind,
    }
  })
}

/** Build the sentinel column nodes. Conversations are counted per host so the
 *  node can show how many it carries. */
export function buildSentinelNodes(
  sentinels: SentinelStatusInfo[],
  conversations: Conversation[],
  usage: ProfileUsageMap,
): Node<SentinelNodeData, 'sentinel'>[] {
  const countByHost = new Map<string, number>()
  for (const c of conversations) {
    if (c.hostSentinelId) countByHost.set(c.hostSentinelId, (countByHost.get(c.hostSentinelId) ?? 0) + 1)
  }

  let y = 0
  return sentinels.map(s => {
    const profiles = profileRows(s, usage)
    const h = sentinelNodeHeight(profiles.length)
    const node: Node<SentinelNodeData, 'sentinel'> = {
      id: sentinelNodeId(s.sentinelId),
      type: 'sentinel',
      position: { x: SENTINEL_COL_X, y },
      selectable: false,
      zIndex: 1,
      data: {
        sentinelId: s.sentinelId,
        alias: s.alias,
        hostname: s.hostname,
        connected: s.connected,
        conversationCount: countByHost.get(s.sentinelId) ?? 0,
        profiles,
      },
    }
    y += h + SENTINEL_GAP
    return node
  })
}

/** Faint host edges sentinel -> conversation; hover accents them. */
export function buildSentinelEdges(sentinels: SentinelStatusInfo[], conversations: Conversation[]): Edge[] {
  const known = new Set(sentinels.map(s => s.sentinelId))
  const edges: Edge[] = []
  for (const c of conversations) {
    const host = c.hostSentinelId
    if (!host || !known.has(host)) continue
    edges.push({
      id: `host:${host}->${c.id}`,
      source: sentinelNodeId(host),
      target: c.id,
      targetHandle: 'host',
      data: { kind: 'host' },
    })
  }
  return edges
}
