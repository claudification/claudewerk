/**
 * Tests for the rename_conversation handler authorization model.
 *
 * Authz rules under test (Phase 1 of plan-conversation-rename):
 *   - agent-host renaming its OWN conversation: allowed, no benevolent needed.
 *   - agent-host renaming ANOTHER conversation: requires benevolent trust.
 *   - dashboard/control-panel: goes through requirePermission('chat', project).
 *   - any non-empty name pins titleUserSet=true (protects against CC auto-titler).
 *   - empty name clears the user-set title.
 */

import { describe, expect, it } from 'bun:test'
import { GuardError, type HandlerContext, type WsData } from '../handler-context'
import { renameConversation } from './control-panel-actions'

interface MockConversation {
  id: string
  project: string
  title?: string
  titleUserSet?: boolean
  description?: string
}

// fallow-ignore-next-line complexity
function makeCtx(
  conversation: MockConversation | undefined,
  opts: {
    wsData?: Partial<WsData>
    benevolent?: boolean
    persisted?: string[]
    updates?: string[]
    replies?: Record<string, unknown>[]
    permissionThrows?: boolean
  } = {},
): HandlerContext {
  const persisted = opts.persisted ?? []
  const updates = opts.updates ?? []
  const replies = opts.replies ?? []
  return {
    ws: { data: opts.wsData ?? {} },
    conversations: {
      getConversation: (id: string) => (conversation && conversation.id === id ? conversation : undefined),
      persistConversationById: (id: string) => persisted.push(id),
      broadcastConversationUpdate: (id: string) => updates.push(id),
    },
    requireBenevolent: () => {
      if (!opts.benevolent) throw new GuardError('Requires benevolent trust level')
    },
    requirePermission: () => {
      if (opts.permissionThrows) throw new GuardError('Permission denied')
    },
    reply: (msg: Record<string, unknown>) => replies.push(msg),
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
}

describe('rename_conversation authz', () => {
  it('agent-host may rename its OWN conversation without benevolent trust', () => {
    const conv: MockConversation = { id: 'conv_self', project: 'claude:///x' }
    const replies: Record<string, unknown>[] = []
    const persisted: string[] = []
    const updates: string[] = []
    const ctx = makeCtx(conv, {
      wsData: { conversationId: 'conv_self' },
      benevolent: false,
      replies,
      persisted,
      updates,
    })
    renameConversation(ctx, { conversationId: 'conv_self', name: 'my-new-name' })
    expect(conv.title).toBe('my-new-name')
    expect(conv.titleUserSet).toBe(true)
    expect(persisted).toEqual(['conv_self'])
    expect(updates).toEqual(['conv_self'])
    expect(replies[0]).toMatchObject({ type: 'rename_conversation_result', ok: true })
  })

  it('agent-host renaming ANOTHER conversation requires benevolent trust', () => {
    const conv: MockConversation = { id: 'conv_other', project: 'claude:///y' }
    const ctx = makeCtx(conv, { wsData: { conversationId: 'conv_self' }, benevolent: false })
    expect(() => renameConversation(ctx, { conversationId: 'conv_other', name: 'x' })).toThrow(GuardError)
    // mutation must NOT have happened
    expect(conv.title).toBeUndefined()
  })

  it('benevolent agent-host may rename ANOTHER conversation', () => {
    const conv: MockConversation = { id: 'conv_other', project: 'claude:///y' }
    const replies: Record<string, unknown>[] = []
    const ctx = makeCtx(conv, { wsData: { conversationId: 'conv_self' }, benevolent: true, replies })
    renameConversation(ctx, { conversationId: 'conv_other', name: 'renamed-by-benevolent' })
    expect(conv.title).toBe('renamed-by-benevolent')
    expect(conv.titleUserSet).toBe(true)
    expect(replies[0]).toMatchObject({ type: 'rename_conversation_result', ok: true })
  })

  it('dashboard rename goes through chat permission (allowed)', () => {
    const conv: MockConversation = { id: 'conv_d', project: 'claude:///z' }
    const replies: Record<string, unknown>[] = []
    const ctx = makeCtx(conv, { wsData: { userName: 'jonas' }, replies })
    renameConversation(ctx, { conversationId: 'conv_d', name: 'dash-name' })
    expect(conv.title).toBe('dash-name')
    expect(replies[0]).toMatchObject({ type: 'rename_conversation_result', ok: true })
  })

  it('dashboard rename is blocked when chat permission is denied', () => {
    const conv: MockConversation = { id: 'conv_d', project: 'claude:///z' }
    const ctx = makeCtx(conv, { wsData: { userName: 'jonas' }, permissionThrows: true })
    expect(() => renameConversation(ctx, { conversationId: 'conv_d', name: 'nope' })).toThrow(GuardError)
    expect(conv.title).toBeUndefined()
  })

  it('empty name clears the user-set title', () => {
    const conv: MockConversation = { id: 'conv_self', project: 'claude:///x', title: 'old', titleUserSet: true }
    const ctx = makeCtx(conv, { wsData: { conversationId: 'conv_self' } })
    renameConversation(ctx, { conversationId: 'conv_self', name: '' })
    expect(conv.title).toBeUndefined()
    expect(conv.titleUserSet).toBe(false)
  })

  it('sets description alongside the name', () => {
    const conv: MockConversation = { id: 'conv_self', project: 'claude:///x' }
    const ctx = makeCtx(conv, { wsData: { conversationId: 'conv_self' } })
    renameConversation(ctx, { conversationId: 'conv_self', name: 'n', description: 'doing the thing' })
    expect(conv.title).toBe('n')
    expect(conv.description).toBe('doing the thing')
  })

  it('throws when conversationId is missing', () => {
    const ctx = makeCtx(undefined, { wsData: { conversationId: 'conv_self' } })
    expect(() => renameConversation(ctx, { name: 'x' })).toThrow(GuardError)
  })

  it('throws when the conversation is not found', () => {
    const ctx = makeCtx(undefined, { wsData: { conversationId: 'conv_self' } })
    expect(() => renameConversation(ctx, { conversationId: 'missing', name: 'x' })).toThrow(GuardError)
  })
})
