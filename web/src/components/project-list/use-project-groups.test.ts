import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { type ConversationStructure, useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectSettings } from '@/lib/types'
import { type ProjectOrder, useProjectGroups } from './use-project-groups'

function conv(over: Partial<ConversationStructure> & { id: string }): ConversationStructure {
  return {
    project: 'claude:///home/me/alpha',
    status: 'idle',
    startedAt: 0,
    capabilities: [],
    ...over,
  } as ConversationStructure
}

function run(
  structure: ConversationStructure[],
  order: ProjectOrder = { tree: [] },
  settings: Record<string, ProjectSettings> = {},
  workspace: string | null = null,
) {
  return renderHook(() => useProjectGroups(structure, order, settings, workspace)).result.current
}

beforeEach(() => {
  useConversationsStore.setState({ conversationsById: {} } as unknown as ReturnType<
    typeof useConversationsStore.getState
  >)
})

describe('useProjectGroups', () => {
  it('groups conversations under their own project', () => {
    const g = run([conv({ id: 'a' }), conv({ id: 'b' })])
    expect(g.visibleIdsByProject.get('claude:///home/me/alpha')).toEqual(['a', 'b'])
  })

  // No toggle, no pref, no escape hatch: an ended conversation never reaches the
  // sidebar. If this test ever needs a flag added back, the flag is the bug.
  it('always hides ended conversations', () => {
    const structure = [conv({ id: 'a' }), conv({ id: 'dead', status: 'ended' })]
    expect(run(structure).visibleIdsByProject.get('claude:///home/me/alpha')).toEqual(['a'])
  })

  it('drops a project entirely when every conversation in it has ended', () => {
    const structure = [conv({ id: 'dead', status: 'ended' }), conv({ id: 'gone', status: 'ended' })]
    expect(run(structure).visibleIdsByProject.get('claude:///home/me/alpha')).toBeUndefined()
  })

  // Spawn lineage transcends project boundaries: a child filed under its root's
  // project keeps the chain together, and its own project gets a stub back.
  it('files a cross-project child under its root project and leaves a stub', () => {
    const g = run([
      conv({ id: 'root', project: 'claude:///home/me/alpha' }),
      conv({ id: 'child', project: 'claude:///home/me/beta', rootConversationId: 'root' }),
    ])
    expect(g.visibleIdsByProject.get('claude:///home/me/alpha')).toEqual(['root', 'child'])
    expect(g.visibleIdsByProject.get('claude:///home/me/beta')).toBeUndefined()
    expect(g.stubIdsByProject.get('claude:///home/me/beta')).toEqual(['root'])
  })

  it('leaves no stub when the root lives in the same project', () => {
    const g = run([conv({ id: 'root' }), conv({ id: 'child', rootConversationId: 'root' })])
    expect(g.stubIdsByProject.size).toBe(0)
  })

  it('sorts ad-hoc-only groups to the bottom of unorganized', () => {
    const g = run([
      conv({ id: 'adhoc', project: 'claude:///tmp/scratch', capabilities: ['ad-hoc'], startedAt: 500 }),
      conv({ id: 'real', project: 'claude:///home/me/alpha', startedAt: 100 }),
    ])
    expect(g.unorganized.map(u => u.project)).toEqual(['claude:///home/me/alpha', 'claude:///tmp/scratch'])
  })

  it('orders same-tier unorganized projects newest first', () => {
    const g = run([
      conv({ id: 'old', project: 'claude:///home/me/alpha', startedAt: 100 }),
      conv({ id: 'new', project: 'claude:///home/me/beta', startedAt: 900 }),
    ])
    expect(g.unorganized.map(u => u.project)).toEqual(['claude:///home/me/beta', 'claude:///home/me/alpha'])
  })

  it('keeps organized projects out of unorganized', () => {
    const order: ProjectOrder = { tree: [{ type: 'project', id: 'claude:///home/me/alpha' }] as never }
    expect(run([conv({ id: 'a' })], order).unorganized).toEqual([])
  })

  it('exposes no inactive roll-up at all -- ended-only projects vanish', () => {
    const g = run([conv({ id: 'dead', status: 'ended', project: 'claude:///home/me/gone' })])
    expect('inactive' in g).toBe(false)
    expect(g.visibleIdsByProject.size).toBe(0)
    expect(g.unorganized).toEqual([])
  })

  it('keeps the live siblings of an ended conversation', () => {
    const g = run([conv({ id: 'dead', status: 'ended' }), conv({ id: 'live' })])
    expect(g.visibleIdsByProject.get('claude:///home/me/alpha')).toEqual(['live'])
  })

  it('surfaces a pinned project with no conversations', () => {
    const settings = { 'claude:///home/me/empty': { pinned: true } } as unknown as Record<string, ProjectSettings>
    expect(run([conv({ id: 'a' })], { tree: [] }, settings).pinnedNotInTree).toEqual(['claude:///home/me/empty'])
  })

  it('narrows the tree to the active workspace', () => {
    const order: ProjectOrder = {
      tree: [{ type: 'project', id: 'claude:///home/me/alpha' }] as never,
      workspaceTrees: { work: [{ type: 'project', id: 'claude:///home/me/beta' }] as never },
    }
    expect(run([], order, {}, 'work').filteredTree).toHaveLength(1)
    expect(run([], order, {}, 'work').filteredTree[0].id).toBe('claude:///home/me/beta')
    expect(run([], order, {}, 'missing').filteredTree).toEqual([])
  })

  it('hides an ended-only project from unorganized', () => {
    expect(run([conv({ id: 'dead', status: 'ended', project: 'claude:///home/me/gone' })]).unorganized).toEqual([])
  })
})
