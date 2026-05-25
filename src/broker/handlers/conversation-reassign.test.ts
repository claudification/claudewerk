import { describe, expect, it } from 'bun:test'
import type { Conversation } from '../../shared/protocol'
import type { HandlerContext, WsData } from '../handler-context'
import type { UserGrant } from '../permissions'
import { handleConversationReassign } from './conversation-reassign'

interface FakeCtxOpts {
  conversation?: Conversation
  grants?: UserGrant[] | undefined
  isControlPanel?: boolean
  userName?: string
}

interface FakeCtxResult {
  ctx: HandlerContext
  replies: Array<Record<string, unknown>>
  broadcasts: Array<{ msg: Record<string, unknown>; project: string }>
  logs: string[]
  persisted: string[]
  updates: string[]
}

function makeCtx(opts: FakeCtxOpts): FakeCtxResult {
  const replies: Array<Record<string, unknown>> = []
  const broadcasts: Array<{ msg: Record<string, unknown>; project: string }> = []
  const logs: string[] = []
  const persisted: string[] = []
  const updates: string[] = []
  const conv = opts.conversation

  const wsData: WsData = {
    isControlPanel: opts.isControlPanel ?? true,
    userName: opts.userName ?? 'tester',
    grants: opts.grants,
  }

  const ctx = {
    ws: { data: wsData },
    conversations: {
      getConversation: (id: string) => (conv && conv.id === id ? conv : undefined),
      persistConversationById: (id: string) => persisted.push(id),
      broadcastConversationUpdate: (id: string) => updates.push(id),
    },
    reply: (msg: Record<string, unknown>) => replies.push(msg),
    broadcastScoped: (msg: Record<string, unknown>, project: string) => broadcasts.push({ msg, project }),
    log: {
      info: (m: string) => logs.push(`info:${m}`),
      debug: (m: string) => logs.push(`debug:${m}`),
      error: (m: string) => logs.push(`error:${m}`),
    },
  } as unknown as HandlerContext

  return { ctx, replies, broadcasts, logs, persisted, updates }
}

function baseConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_aaaaaaaa',
    project: 'claude:///source/proj',
    status: 'idle',
    hostSentinelId: 'snt_old',
    resolvedProfile: 'profA',
    agentHostMeta: { ccSessionId: 'cc_must_not_be_touched' },
    ...overrides,
  } as Conversation
}

describe('conversation_reassign handler', () => {
  it('rejects when targetConversation is missing', () => {
    const { ctx, replies } = makeCtx({ grants: [{ scope: '*', roles: ['admin'] }] })
    handleConversationReassign(ctx, { type: 'conversation_reassign' })
    expect(replies).toHaveLength(1)
    expect(replies[0]?.ok).toBe(false)
    expect(replies[0]?.error).toBe('Missing targetConversation')
  })

  it('rejects when conversation not found', () => {
    const { ctx, replies } = makeCtx({ grants: [{ scope: '*', roles: ['admin'] }] })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: 'conv_nope',
      toProjectUri: 'claude:///x/y',
    })
    expect(replies[0]?.ok).toBe(false)
    expect(replies[0]?.error).toBe('Conversation not found')
  })

  it('rejects when no fields are provided', () => {
    const { ctx, replies } = makeCtx({
      conversation: baseConv(),
      grants: [{ scope: '*', roles: ['admin'] }],
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: 'conv_aaaaaaaa',
    })
    expect(replies[0]?.ok).toBe(false)
    expect(replies[0]?.error).toBe('No fields to reassign')
  })

  it('denies non-admin on source project', () => {
    const conv = baseConv()
    const { ctx, replies, persisted } = makeCtx({
      conversation: conv,
      grants: [{ scope: 'claude:///other/*', roles: ['admin'] }], // admin on a different scope
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: conv.id,
      toProjectUri: 'claude:///dest/proj',
    })
    expect(replies[0]?.ok).toBe(false)
    expect(String(replies[0]?.error)).toContain('admin required on source')
    expect(persisted).toHaveLength(0)
    expect(conv.project).toBe('claude:///source/proj')
  })

  it('denies admin-on-source-only when reassigning to a target project', () => {
    const conv = baseConv()
    const { ctx, replies, persisted } = makeCtx({
      conversation: conv,
      grants: [{ scope: 'claude:///source/*', roles: ['admin'] }], // admin only on source
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: conv.id,
      toProjectUri: 'claude:///dest/proj',
    })
    expect(replies[0]?.ok).toBe(false)
    expect(String(replies[0]?.error)).toContain('admin required on target')
    expect(persisted).toHaveLength(0)
    expect(conv.project).toBe('claude:///source/proj')
  })

  it('applies when admin on both source and target', () => {
    const conv = baseConv()
    const { ctx, replies, broadcasts, persisted, updates, logs } = makeCtx({
      conversation: conv,
      grants: [{ scope: '*', roles: ['admin'] }],
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: conv.id,
      toProjectUri: 'claude:///dest/proj',
      toHostSentinelId: 'snt_new',
      toProfile: 'profB',
      batchId: 'batch_test1234',
    })
    expect(replies[0]?.ok).toBe(true)
    expect(conv.project).toBe('claude:///dest/proj')
    expect(conv.hostSentinelId).toBe('snt_new')
    expect(conv.resolvedProfile).toBe('profB')
    expect(persisted).toEqual([conv.id])
    expect(updates).toEqual([conv.id])
    // Broadcast to both old and new project
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts.map(b => b.project).sort()).toEqual(['claude:///dest/proj', 'claude:///source/proj'].sort())
    expect(broadcasts[0]?.msg.type).toBe('conversation_reassigned')
    expect((broadcasts[0]?.msg as { batchId?: string }).batchId).toBe('batch_test1234')
    // Log includes prev->next, batch, initiator
    expect(logs.some(l => l.includes('batch=batch_test1234') && l.includes('->'))).toBe(true)
  })

  it('leaves omitted fields unchanged', () => {
    const conv = baseConv()
    const { ctx, replies } = makeCtx({
      conversation: conv,
      grants: [{ scope: '*', roles: ['admin'] }],
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: conv.id,
      toProfile: 'profC',
    })
    expect(replies[0]?.ok).toBe(true)
    expect(conv.project).toBe('claude:///source/proj') // unchanged
    expect(conv.hostSentinelId).toBe('snt_old') // unchanged
    expect(conv.resolvedProfile).toBe('profC') // changed
  })

  it('clears hostSentinelId on explicit null', () => {
    const conv = baseConv()
    const { ctx, replies } = makeCtx({
      conversation: conv,
      grants: [{ scope: '*', roles: ['admin'] }],
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: conv.id,
      toHostSentinelId: null,
    })
    expect(replies[0]?.ok).toBe(true)
    expect(conv.hostSentinelId).toBeUndefined()
  })

  it('clears resolvedProfile on explicit null', () => {
    const conv = baseConv()
    const { ctx, replies } = makeCtx({
      conversation: conv,
      grants: [{ scope: '*', roles: ['admin'] }],
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: conv.id,
      toProfile: null,
    })
    expect(replies[0]?.ok).toBe(true)
    expect(conv.resolvedProfile).toBeUndefined()
  })

  it('never touches conversationId or ccSessionId', () => {
    const conv = baseConv()
    const prevId = conv.id
    const prevMeta = { ...conv.agentHostMeta }
    const { ctx } = makeCtx({
      conversation: conv,
      grants: [{ scope: '*', roles: ['admin'] }],
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: conv.id,
      toProjectUri: 'claude:///dest/proj',
      toHostSentinelId: 'snt_new',
      toProfile: 'profB',
    })
    expect(conv.id).toBe(prevId)
    expect(conv.agentHostMeta).toEqual(prevMeta)
    expect((conv.agentHostMeta as { ccSessionId?: string }).ccSessionId).toBe('cc_must_not_be_touched')
  })

  it('rejects invalid toHostSentinelId type', () => {
    const conv = baseConv()
    const { ctx, replies } = makeCtx({
      conversation: conv,
      grants: [{ scope: '*', roles: ['admin'] }],
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: conv.id,
      toHostSentinelId: 42 as unknown as string,
    })
    expect(replies[0]?.ok).toBe(false)
    expect(replies[0]?.error).toBe('toHostSentinelId must be string or null')
  })

  it('infrastructure connections (no isControlPanel) bypass admin check', () => {
    const conv = baseConv()
    const { ctx, replies } = makeCtx({
      conversation: conv,
      isControlPanel: false,
      grants: undefined,
    })
    handleConversationReassign(ctx, {
      type: 'conversation_reassign',
      targetConversation: conv.id,
      toProfile: 'profC',
    })
    expect(replies[0]?.ok).toBe(true)
  })
})
