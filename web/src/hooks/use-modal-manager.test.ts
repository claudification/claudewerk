/**
 * Tests for the unified minimizable-modals manager.
 *
 * Pins the two behaviours the design hinges on: blocking modals never park, and
 * restore WARPS to the owning conversation before re-opening (the
 * restore-from-another-context case from plan-unified-modals.md).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import { useConversationsStore } from './use-conversations'
import { useModalManagerStore } from './use-modal-manager'

function conv(id: string): Conversation {
  return {
    id,
    project: '/home/user/project',
    status: 'idle',
    startedAt: Date.now() - 60_000,
    lastActivity: Date.now(),
    eventCount: 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
  } as Conversation
}

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
  useConversationsStore.setState({
    conversationsById: { conv_a: conv('conv_a'), conv_b: conv('conv_b') },
    selectedConversationId: null,
    selectedProjectUri: null,
  })
})

const OPTS = { id: 'debug-control', kind: 'debug-control', title: 'Debug: control' }

describe('modal manager', () => {
  it('opens an instance with its owner scope captured', () => {
    useModalManagerStore.getState().open(OPTS, { type: 'conversation', id: 'conv_a' })
    const rec = useModalManagerStore.getState().records['debug-control']
    expect(rec?.phase).toBe('open')
    expect(rec?.scope).toEqual({ type: 'conversation', id: 'conv_a' })
  })

  it('minimizes a parkable modal into the dock', () => {
    const s = useModalManagerStore.getState()
    s.open(OPTS, { type: 'conversation', id: 'conv_a' })
    s.minimize('debug-control')
    expect(useModalManagerStore.getState().records['debug-control']?.phase).toBe('minimized')
  })

  it('refuses to minimize a blocking modal', () => {
    const s = useModalManagerStore.getState()
    s.open({ ...OPTS, id: 'rename', minimizable: false }, { type: 'conversation', id: 'conv_a' })
    s.minimize('rename')
    expect(useModalManagerStore.getState().records.rename?.phase).toBe('open')
  })

  it('restore WARPS to the owning conversation, then re-opens', () => {
    const s = useModalManagerStore.getState()
    s.open(OPTS, { type: 'conversation', id: 'conv_a' })
    s.minimize('debug-control')
    // Navigate away to a different conversation.
    useConversationsStore.getState().selectConversation('conv_b', 'test')
    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_b')

    s.restore('debug-control')
    // Warped back to the owner...
    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_a')
    // ...and re-opened.
    expect(useModalManagerStore.getState().records['debug-control']?.phase).toBe('open')
  })

  it('close drops the instance entirely', () => {
    const s = useModalManagerStore.getState()
    s.open(OPTS, { type: 'global' })
    s.close('debug-control')
    expect(useModalManagerStore.getState().records['debug-control']).toBeUndefined()
  })
})
