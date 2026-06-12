import { describe, expect, it } from 'vitest'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { EXPANDED_H, EXPANDED_W, layoutCanvas, NODE_H, NODE_W } from './layout'
import { buildSentinelEdges, buildSentinelNodes } from './sentinels'

// layoutCanvas only reads id / project / status / lastActivity / stats /
// parentConversationId (+ label fields), so a tiny partial cast keeps the
// fixtures legible -- same convention as lineage.test.ts.
function conv(id: string, project: string, parentConversationId?: string, status = 'idle'): Conversation {
  return {
    id,
    project,
    parentConversationId,
    status,
    lastActivity: 1000,
    startedAt: 1,
    hostSentinelId: 'snt_1',
  } as unknown as Conversation
}

const NOW = 2000
const NONE: ReadonlySet<string> = new Set()

interface Rect {
  position: { x: number; y: number }
  width?: number
  height?: number
}

function rectsOverlap(s: Rect, t: Rect): boolean {
  const overlapX = s.position.x < t.position.x + (t.width ?? 0) && t.position.x < s.position.x + (s.width ?? 0)
  const overlapY = s.position.y < t.position.y + (t.height ?? 0) && t.position.y < s.position.y + (s.height ?? 0)
  return overlapX && overlapY
}

describe('layoutCanvas', () => {
  it('emits one project space per project plus one card per conversation', () => {
    const { nodes } = layoutCanvas(
      [conv('a', 'claude:///p1'), conv('b', 'claude:///p1'), conv('c', 'claude:///p2')],
      null,
      NOW,
      NONE,
    )
    const spaces = nodes.filter(n => n.type === 'projectSpace')
    const cards = nodes.filter(n => n.type === 'conversation')
    expect(spaces.map(s => s.id).sort()).toEqual(['space:claude:///p1', 'space:claude:///p2'])
    expect(cards).toHaveLength(3)
  })

  it('contains every card inside its project space rect', () => {
    const { nodes } = layoutCanvas([conv('a', 'claude:///p1'), conv('b', 'claude:///p1', 'a')], null, NOW, NONE)
    const space = nodes.find(n => n.id === 'space:claude:///p1')
    if (!space) throw new Error('space missing')
    for (const card of nodes.filter(n => n.type === 'conversation')) {
      expect(card.position.x).toBeGreaterThanOrEqual(space.position.x)
      expect(card.position.y).toBeGreaterThanOrEqual(space.position.y)
      expect(card.position.x + NODE_W).toBeLessThanOrEqual(space.position.x + (space.width ?? 0))
      expect(card.position.y + NODE_H).toBeLessThanOrEqual(space.position.y + (space.height ?? 0))
    }
  })

  it('grows an expanded card and keeps it inside its space', () => {
    const expanded = new Set(['a'])
    const { nodes } = layoutCanvas([conv('a', 'claude:///p1'), conv('b', 'claude:///p1', 'a')], null, NOW, expanded)
    const card = nodes.find(n => n.id === 'a')
    const space = nodes.find(n => n.id === 'space:claude:///p1')
    if (!card || !space) throw new Error('node missing')
    expect((card.data as { expanded: boolean }).expanded).toBe(true)
    expect(card.position.x + EXPANDED_W).toBeLessThanOrEqual(space.position.x + (space.width ?? 0))
    expect(card.position.y + EXPANDED_H).toBeLessThanOrEqual(space.position.y + (space.height ?? 0))
  })

  it('tags spawn edges, cross-project ones distinctly', () => {
    const { edges } = layoutCanvas(
      [conv('root', 'claude:///p1'), conv('kid', 'claude:///p1', 'root'), conv('far', 'claude:///p2', 'root')],
      null,
      NOW,
      NONE,
    )
    expect(edges.map(e => e.id).sort()).toEqual(['root->far', 'root->kid'])
    expect(edges.find(e => e.id === 'root->kid')?.data?.kind).toBe('lineage')
    expect(edges.find(e => e.id === 'root->far')?.data?.kind).toBe('lineage-cross')
  })

  it('skips edges whose parent is not on the canvas', () => {
    const { edges } = layoutCanvas([conv('kid', 'claude:///p1', 'gone-parent')], null, NOW, NONE)
    expect(edges).toEqual([])
  })

  it('keeps project spaces from overlapping', () => {
    const list = [
      ...Array.from({ length: 6 }, (_, i) => conv(`a${i}`, 'claude:///p1')),
      ...Array.from({ length: 4 }, (_, i) => conv(`b${i}`, 'claude:///p2')),
      conv('c0', 'claude:///p3'),
    ]
    const { nodes } = layoutCanvas(list, null, NOW, NONE)
    const spaces = nodes.filter(n => n.type === 'projectSpace')
    const pairs = spaces.flatMap(s => spaces.filter(t => t.id !== s.id).map(t => [s, t] as const))
    for (const [s, t] of pairs) {
      expect(rectsOverlap(s, t)).toBe(false)
    }
  })

  it('marks the selected conversation', () => {
    const { nodes } = layoutCanvas([conv('a', 'claude:///p1'), conv('b', 'claude:///p1')], 'b', NOW, NONE)
    expect(nodes.find(n => n.id === 'b')?.selected).toBe(true)
    expect(nodes.find(n => n.id === 'a')?.selected).toBe(false)
  })
})

describe('sentinel nodes + edges', () => {
  const sentinel = {
    sentinelId: 'snt_1',
    alias: 'mainframe',
    connected: true,
    profiles: [{ name: 'default' }, { name: 'work', pool: 'work' }],
  } as unknown as SentinelStatusInfo

  it('joins profile usage onto sentinel profile rows', () => {
    const usage = {
      'snt_1/work': {
        profile: 'work',
        authed: true,
        polledAt: 1,
        sentinelId: 'snt_1',
        fiveHour: { usedPercent: 42, resetAt: '' },
        sevenDay: { usedPercent: 71, resetAt: '' },
      },
    }
    const [node] = buildSentinelNodes([sentinel], [conv('a', 'claude:///p1')], usage)
    expect(node.id).toBe('sentinel:snt_1')
    expect(node.data.conversationCount).toBe(1)
    const work = node.data.profiles.find(p => p.name === 'work')
    expect(work?.fiveHourPct).toBe(42)
    expect(work?.sevenDayPct).toBe(71)
    expect(node.data.profiles.find(p => p.name === 'default')?.authed).toBe(false)
  })

  it('links each hosted conversation to its sentinel, skipping unknown hosts', () => {
    const convs = [conv('a', 'claude:///p1'), conv('b', 'claude:///p1')]
    ;(convs[1] as unknown as { hostSentinelId: string }).hostSentinelId = 'snt_ghost'
    const edges = buildSentinelEdges([sentinel], convs)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: 'sentinel:snt_1', target: 'a', targetHandle: 'host' })
    expect(edges[0].data?.kind).toBe('host')
  })
})
