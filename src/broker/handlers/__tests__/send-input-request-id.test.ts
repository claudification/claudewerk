/**
 * The control panel resolves an in-flight `send_input` by `requestId` -- an
 * unresolved send eventually times out client-side, and a rejected one is
 * parked in the message outbox for retry. That only works if the broker echoes
 * the id on BOTH outcomes; the router already did it for the GuardError path,
 * the handler has to do it for the success path.
 */
import { describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { HandlerContext, MessageData } from '../../handler-context'
import { routeMessage } from '../../message-router'
import { registerDashboardActionHandlers } from '../control-panel-actions'

registerDashboardActionHandlers()

type Reply = Record<string, unknown>

function makeCtx(opts: { hostConnected: boolean }): { ctx: HandlerContext; replies: Reply[]; sentToHost: string[] } {
  const replies: Reply[] = []
  const sentToHost: string[] = []
  const host = { send: (raw: string) => sentToHost.push(raw) } as unknown as ServerWebSocket<unknown>
  const conversation = { id: 'conv_1', status: 'active', project: 'claude:///tmp/p', backend: undefined }

  const ctx = {
    ws: { data: { isControlPanel: true, userName: 'jonas' } },
    conversations: {
      getConversation: () => conversation,
      registerImpulse: () => {},
      getConversationSocket: () => (opts.hostConnected ? host : undefined),
      getConnectionIds: () => [],
      findSocketByConversationId: () => undefined,
    },
    requirePermission: () => {},
    reply: (msg: Reply) => replies.push(msg),
    log: { info: () => {}, error: () => {}, debug: () => {} },
    verbose: false,
  } as unknown as HandlerContext

  return { ctx, replies, sentToHost }
}

function send(ctx: HandlerContext, data: MessageData) {
  routeMessage(ctx, 'send_input', data)
}

describe('send_input requestId echo', () => {
  it('echoes requestId on a delivered send', () => {
    const { ctx, replies, sentToHost } = makeCtx({ hostConnected: true })
    send(ctx, { conversationId: 'conv_1', input: 'hello', requestId: 'req_abc' })
    expect(replies).toEqual([{ type: 'send_input_result', ok: true, requestId: 'req_abc' }])
    expect(JSON.parse(sentToHost[0])).toMatchObject({ type: 'input', input: 'hello' })
  })

  it('echoes requestId when the agent host is gone, so the panel can queue the text', () => {
    const { ctx, replies } = makeCtx({ hostConnected: false })
    send(ctx, { conversationId: 'conv_1', input: 'hello', requestId: 'req_abc' })
    expect(replies).toEqual([
      { type: 'send_input_result', ok: false, error: 'Conversation not connected', requestId: 'req_abc' },
    ])
  })

  it('omits requestId entirely when the client did not send one', () => {
    const { ctx, replies } = makeCtx({ hostConnected: true })
    send(ctx, { conversationId: 'conv_1', input: 'hello' })
    expect(replies).toEqual([{ type: 'send_input_result', ok: true }])
  })
})
