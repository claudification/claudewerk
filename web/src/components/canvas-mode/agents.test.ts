/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import { buildAgentNodes, earliestAgentExpiry } from './agents'
import { AGENT_TTL_MS } from './canvas-types'
import type { CardRect } from './layout'

type Subagent = Conversation['subagents'][number]

function agent(agentId: string, status: 'running' | 'stopped', stoppedAt?: number): Subagent {
  return { agentId, agentType: 'Explore', status, startedAt: 0, stoppedAt, eventCount: 0 } as Subagent
}

function conv(id: string, subagents: Subagent[]): Conversation {
  return { id, project: 'claude:///p', status: 'active', subagents } as unknown as Conversation
}

const RECT: CardRect = { x: 100, y: 200, w: 252, h: 96 }
const NOW = 1_000_000

function rects(...ids: string[]): Map<string, CardRect> {
  return new Map(ids.map(id => [id, RECT]))
}

describe('buildAgentNodes', () => {
  it('emits a node + edge per running agent, fanned right of the parent card', () => {
    const { nodes, edges } = buildAgentNodes(
      [conv('c', [agent('a1', 'running'), agent('a2', 'running')])],
      rects('c'),
      NOW,
    )
    expect(nodes).toHaveLength(2)
    expect(edges).toHaveLength(2)
    // first agent sits to the right of the card
    expect(nodes[0].position.x).toBeGreaterThan(RECT.x + RECT.w)
    // stacked vertically
    expect(nodes[1].position.y).toBeGreaterThan(nodes[0].position.y)
    expect(nodes[0].data.fading).toBe(false)
    expect(edges[0].source).toBe('c')
    expect(edges[0].sourceHandle).toBe('agents')
  })

  it('keeps a just-stopped agent (fading) within the linger window', () => {
    const { nodes } = buildAgentNodes([conv('c', [agent('a1', 'stopped', NOW - 1000)])], rects('c'), NOW)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].data.fading).toBe(true)
  })

  it('drops a stopped agent past the linger window', () => {
    const { nodes } = buildAgentNodes([conv('c', [agent('a1', 'stopped', NOW - AGENT_TTL_MS - 1)])], rects('c'), NOW)
    expect(nodes).toHaveLength(0)
  })

  it('skips agents whose parent has no card rect (filtered/hidden parent)', () => {
    const { nodes } = buildAgentNodes([conv('c', [agent('a1', 'running')])], rects('other'), NOW)
    expect(nodes).toHaveLength(0)
  })
})

describe('earliestAgentExpiry', () => {
  it('returns the soonest future stopped-agent expiry', () => {
    const convs = [conv('c', [agent('a1', 'stopped', NOW - 1000), agent('a2', 'stopped', NOW - 5000)])]
    expect(earliestAgentExpiry(convs, NOW)).toBe(NOW - 5000 + AGENT_TTL_MS)
  })

  it('ignores running agents and returns null when nothing is pending', () => {
    expect(earliestAgentExpiry([conv('c', [agent('a1', 'running')])], NOW)).toBeNull()
  })
})
