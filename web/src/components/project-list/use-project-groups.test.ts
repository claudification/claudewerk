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
  showEnded = false,
  workspace: string | null = null,
) {
  return renderHook(() => useProjectGroups(structure, order, settings, showEnded, workspace)).result.current
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

  it('hides ended conversations unless showEnded', () => {
    const structure = [conv({ id: 'a' }), conv({ id: 'dead', status: 'ended' })]
    expect(run(structure).visibleIdsByProject.get('claude:///home/me/alpha')).toEqual(['a'])
    expect(run(structure, { tree: [] }, {}, true).visibleIdsByProject.get('claude:///home/me/alpha')).toEqual([
      'a',
      'dead',
    ])
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

  it('groups a project whose conversations have all ended into inactive', () => {
    const g = run([conv({ id: 'dead', status: 'ended', project: 'claude:///home/me/gone' })])
    expect(g.inactive).toHaveLength(1)
    expect(g.inactive[0][0].id).toBe('dead')
  })

  it('keeps a project out of inactive while any conversation is live', () => {
    const g = run([conv({ id: 'dead', status: 'ended' }), conv({ id: 'live' })])
    expect(g.inactive).toEqual([])
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
    expect(run([], order, {}, false, 'work').filteredTree).toHaveLength(1)
    expect(run([], order, {}, false, 'work').filteredTree[0].id).toBe('claude:///home/me/beta')
    expect(run([], order, {}, false, 'missing').filteredTree).toEqual([])
  })
})
