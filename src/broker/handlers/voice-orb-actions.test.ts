import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDispatchAudit, initDispatchAudit } from '../desk/audit'
import type { HandlerContext, MessageData, WsData } from '../handler-context'
import { routeMessage } from '../message-router'
import { registerVoiceOrbHandlers } from './voice-orb-actions'

beforeAll(() => {
  registerVoiceOrbHandlers()
  // confirm_expensive reads the decision audit -- without it every release
  // fails on plumbing instead of on the decision actually being unknown.
  initDispatchAudit(mkdtempSync(join(tmpdir(), 'voice-orb-audit-')))
})
afterAll(() => closeDispatchAudit())

/** Drive one wire message through the real router and collect the replies.
 *  `permit:false` makes requirePermission throw the way the live gate does. */
async function run(
  data: MessageData,
  wsData: Partial<WsData>,
  opts: { permit?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  const replies: Record<string, unknown>[] = []
  const ctx = {
    ws: { data: wsData, send() {} },
    conversations: { getAllConversations: () => [] },
    store: { transcripts: { search: () => [] } },
    reply: (m: Record<string, unknown>) => replies.push(m),
    requirePermission: () => {
      if (opts.permit === false) throw new Error("Forbidden: missing 'spawn' permission")
    },
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  routeMessage(ctx, 'voice_tool_call', data)
  // The handler is async (a tool execute may await); let its microtasks drain.
  await new Promise(r => setTimeout(r, 0))
  return replies
}

const CONTROL_PANEL: Partial<WsData> = { userName: 'jonas', isControlPanel: true }

describe('voice_tool_call -- the contract gate', () => {
  it('executes a contract tool and echoes the requestId', async () => {
    const replies = await run({ requestId: 'v1', name: 'projects_overview', args: {} }, CONTROL_PANEL)
    expect(replies[0]).toMatchObject({ type: 'voice_tool_call_result', requestId: 'v1', ok: true })
    expect(replies[0].result).toBeDefined()
  })

  it('REFUSES a destructive verb that is not in the voice contract', async () => {
    for (const name of ['terminate', 'inject', 'interrupt', 'configure', 'spawn']) {
      const replies = await run({ requestId: 'v2', name, args: { conversationId: 'c1' } }, CONTROL_PANEL)
      expect(replies[0]).toMatchObject({ type: 'voice_tool_call_result', ok: false, name })
      expect(String(replies[0].error)).toContain('not in the voice contract')
    }
  })

  it('ACCEPTS the explicit action verbs -- they clear the contract gate', async () => {
    // Schema rejection proves it got PAST the contract check to the zod gate.
    const replies = await run({ requestId: 'v3', name: 'dispatch_quest', args: {} }, CONTROL_PANEL)
    expect(String(replies[0].error)).toContain('invalid args')
    expect(String(replies[0].error)).not.toContain('not in the voice contract')
  })

  it('REFUSES the dispatcher ROUTING brain -- the orb reads it, never drives it', async () => {
    for (const name of ['dispatch', 'conversation_select', 'confirm_expensive']) {
      const replies = await run({ requestId: 'v3b', name, args: { intent: 'do a thing' } }, CONTROL_PANEL)
      expect(String(replies[0].error)).toContain('not in the voice contract')
    }
  })

  it('never executes say_to_conversation server-side -- it is client-local', async () => {
    // The browser intercepts it; if it ever reaches the broker the stub says so
    // rather than silently doing nothing.
    const replies = await run(
      { requestId: 'v3d', name: 'say_to_conversation', args: { message: 'hi', target: null } },
      CONTROL_PANEL,
    )
    expect(replies[0]).toMatchObject({ ok: true })
    expect(JSON.stringify(replies[0].result)).toContain('handled in the browser')
  })

  it('rejects a quest with a complexity the schema does not know', async () => {
    const replies = await run(
      {
        requestId: 'v3c',
        name: 'dispatch_quest',
        args: { project: 'arr', task: 'check for new movies', complexity: 'trivial' },
      },
      CONTROL_PANEL,
    )
    expect(String(replies[0].error)).toContain('invalid args')
  })

  it('rejects args the tool schema does not accept', async () => {
    const replies = await run({ requestId: 'v4', name: 'read_events', args: { limit: 5 } }, CONTROL_PANEL)
    expect(replies[0]).toMatchObject({ type: 'voice_tool_call_result', requestId: 'v4', ok: false })
    expect(String(replies[0].error)).toContain('invalid args')
  })

  it('rejects a call with no tool name', async () => {
    const replies = await run({ requestId: 'v5' }, CONTROL_PANEL)
    expect(replies[0]).toMatchObject({ ok: false, requestId: 'v5' })
    expect(String(replies[0].error)).toContain('tool name')
  })

  it('enforces the spawn permission, correlated so the bridge never hangs', async () => {
    const replies = await run({ requestId: 'v6', name: 'projects_overview', args: {} }, CONTROL_PANEL, {
      permit: false,
    })
    expect(replies[0]).toMatchObject({ type: 'voice_tool_call_result', requestId: 'v6', ok: false })
    expect(String(replies[0].error)).toContain('Forbidden')
  })

  it('is CONTROL_PANEL_ONLY -- a share viewer cannot drive the fleet by voice', async () => {
    const replies = await run({ requestId: 'v7', name: 'projects_overview', args: {} }, {})
    expect(replies[0]).toMatchObject({ type: 'voice_tool_call_result', ok: false, requestId: 'v7' })
    expect(String(replies[0].error)).toContain('Forbidden')
  })
})

/** Drive a voice_orb_say through the router with a conversation lookup + socket. */
async function runSay(
  data: MessageData,
  opts: { conv?: { title?: string }; connected?: boolean; permit?: boolean } = {},
): Promise<{ replies: Record<string, unknown>[]; sent: string[] }> {
  const replies: Record<string, unknown>[] = []
  const sent: string[] = []
  const socket = opts.connected ? { send: (s: string) => sent.push(s) } : undefined
  const ctx = {
    ws: { data: { userName: 'jonas', isControlPanel: true }, send() {} },
    conversations: {
      getAllConversations: () => [],
      getConversation: () => opts.conv,
      findSocketByConversationId: () => socket,
      getConversationSocket: () => socket,
    },
    store: { transcripts: { search: () => [] } },
    reply: (m: Record<string, unknown>) => replies.push(m),
    requirePermission: () => {
      if (opts.permit === false) throw new Error("Forbidden: missing 'spawn' permission")
    },
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  routeMessage(ctx, 'voice_orb_say', data)
  await new Promise(r => setTimeout(r, 0))
  return { replies, sent }
}

const SAY = (over: Partial<MessageData> = {}): MessageData =>
  ({ conversationId: 'conv_1', message: 'run the tests', orbId: 'k7p2qz', ...over }) as MessageData

describe('voice_orb_say -- the orb speaking TO a conversation', () => {
  it('delivers a channel_deliver from orb:<id> (source=rclaude, sender=orb)', async () => {
    const { replies, sent } = await runSay(SAY(), { conv: { title: 'the arr one' }, connected: true })
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0])).toEqual({
      type: 'channel_deliver',
      fromConversation: 'orb:k7p2qz',
      fromProject: 'orb',
      sender: 'orb',
      source: 'rclaude',
      intent: 'request',
      message: 'run the tests',
    })
    expect(replies[0]).toMatchObject({ ok: true, to: 'the arr one', from: 'orb:k7p2qz' })
  })

  it('no orbId -> broadcasts from bare "orb"', async () => {
    const { sent } = await runSay(SAY({ orbId: undefined }), { conv: { title: 'x' }, connected: true })
    expect(JSON.parse(sent[0]).fromConversation).toBe('orb')
  })

  it('missing message -> ok:false, nothing sent', async () => {
    const { replies, sent } = await runSay(SAY({ message: '' }), { conv: { title: 'x' }, connected: true })
    expect(replies[0]).toMatchObject({ ok: false })
    expect(String(replies[0].error)).toContain('required')
    expect(sent).toHaveLength(0)
  })

  it('conversation not connected -> ok:false', async () => {
    const { replies, sent } = await runSay(SAY(), { conv: { title: 'x' }, connected: false })
    expect(String(replies[0].error)).toContain('not connected')
    expect(sent).toHaveLength(0)
  })

  it('permission denied -> ok:false, nothing sent', async () => {
    const { replies, sent } = await runSay(SAY(), { conv: { title: 'x' }, connected: true, permit: false })
    expect(replies[0]).toMatchObject({ ok: false })
    expect(sent).toHaveLength(0)
  })
})
