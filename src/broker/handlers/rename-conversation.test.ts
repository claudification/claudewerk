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
import { renameConversation } from './rename-conversation'

interface MockConversation {
  id: string
  project: string
  title?: string
  titleUserSet?: boolean
  description?: string
  formerSlugs?: Array<{ slug: string; retiredAt: number; lastUsedAt: number }>
}

interface CtxOpts {
  wsData: Partial<WsData>
  benevolent: boolean
  persisted: string[]
  updates: string[]
  replies: Record<string, unknown>[]
  permissionThrows: boolean
  /** Messages the handler pushed down the agent-host socket. */
  hostSends: Record<string, unknown>[]
  /** false = no live agent host (ended conversation / host not booted). */
  hasHostSocket: boolean
}

function makeCtx(conversation: MockConversation | undefined, opts: Partial<CtxOpts> = {}): HandlerContext {
  // Single defaults-spread (no per-field ?? branches) keeps this helper simple.
  const o: CtxOpts = {
    wsData: {},
    benevolent: false,
    persisted: [],
    updates: [],
    replies: [],
    permissionThrows: false,
    hostSends: [],
    hasHostSocket: true,
    ...opts,
  }
  const hostSocket = { send: (raw: string) => o.hostSends.push(JSON.parse(raw)) }
  return {
    ws: { data: o.wsData },
    conversations: {
      getConversation: (id: string) => (conversation && conversation.id === id ? conversation : undefined),
      persistConversationById: (id: string) => o.persisted.push(id),
      broadcastConversationUpdate: (id: string) => o.updates.push(id),
      getConversationSocket: () => (o.hasHostSocket ? hostSocket : undefined),
      getConnectionIds: () => [],
      findSocketByConversationId: () => undefined,
    },
    requireBenevolent: () => {
      if (!o.benevolent) throw new GuardError('Requires benevolent trust level')
    },
    requirePermission: () => {
      if (o.permissionThrows) throw new GuardError('Permission denied')
    },
    reply: (msg: Record<string, unknown>) => o.replies.push(msg),
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

  it('retires the old custom slug into formerSlugs on rename', () => {
    const conv: MockConversation = { id: 'conv_self', project: 'claude:///x', title: 'old-name', titleUserSet: true }
    const ctx = makeCtx(conv, { wsData: { conversationId: 'conv_self' } })
    renameConversation(ctx, { conversationId: 'conv_self', name: 'new-name' })
    expect(conv.title).toBe('new-name')
    expect(conv.formerSlugs?.map(e => e.slug)).toEqual(['old-name'])
  })

  it('does NOT retire an alias when the old title was auto (no custom name)', () => {
    const conv: MockConversation = { id: 'conv_self', project: 'claude:///x' }
    const ctx = makeCtx(conv, { wsData: { conversationId: 'conv_self' } })
    renameConversation(ctx, { conversationId: 'conv_self', name: 'first-name' })
    expect(conv.formerSlugs ?? []).toEqual([])
  })

  // The broker's title and CC's own title are two copies of one fact. If only
  // the broker's copy moves, CC's stale `custom-title` JSONL line reverts the
  // rename on the next transcript replay -- which is exactly how renames looked
  // "not persisted" after a broker restart.
  it('REGRESSION: pushes set_title down to the live agent host so CC renames itself', () => {
    const conv: MockConversation = { id: 'conv_self', project: 'claude:///x', title: 'stellar-cobra' }
    const hostSends: Record<string, unknown>[] = []
    const ctx = makeCtx(conv, { wsData: { conversationId: 'conv_self' }, hostSends })

    renameConversation(ctx, { conversationId: 'conv_self', name: 'bug-rename-clobber' })

    expect(hostSends).toEqual([{ type: 'control', action: 'set_title', title: 'bug-rename-clobber' }])
  })

  it('pushes nothing when the title is CLEARED -- there is no name to give CC', () => {
    const conv: MockConversation = { id: 'conv_self', project: 'claude:///x', title: 'old', titleUserSet: true }
    const hostSends: Record<string, unknown>[] = []
    const ctx = makeCtx(conv, { wsData: { conversationId: 'conv_self' }, hostSends })

    renameConversation(ctx, { conversationId: 'conv_self', name: '' })

    expect(hostSends).toEqual([])
  })

  it('still persists + replies when there is no live agent host to push to', () => {
    const conv: MockConversation = { id: 'conv_self', project: 'claude:///x' }
    const replies: Record<string, unknown>[] = []
    const persisted: string[] = []
    const ctx = makeCtx(conv, {
      wsData: { conversationId: 'conv_self' },
      hasHostSocket: false,
      replies,
      persisted,
    })

    renameConversation(ctx, { conversationId: 'conv_self', name: 'offline-rename' })

    expect(conv.title).toBe('offline-rename')
    expect(persisted).toEqual(['conv_self'])
    expect(replies[0]).toMatchObject({ ok: true })
  })

  it('renaming back to a former name drops it from formerSlugs', () => {
    const conv: MockConversation = {
      id: 'conv_self',
      project: 'claude:///x',
      title: 'current',
      titleUserSet: true,
      formerSlugs: [{ slug: 'was-this', retiredAt: 1, lastUsedAt: 2 }],
    }
    const ctx = makeCtx(conv, { wsData: { conversationId: 'conv_self' } })
    renameConversation(ctx, { conversationId: 'conv_self', name: 'was-this' })
    expect(conv.title).toBe('was-this')
    expect(conv.formerSlugs?.find(e => e.slug === 'was-this')).toBeUndefined()
    // the previously-current "current" slug is now retired
    expect(conv.formerSlugs?.find(e => e.slug === 'current')).toBeDefined()
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
