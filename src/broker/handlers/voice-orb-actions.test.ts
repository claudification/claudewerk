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

  it('ACCEPTS the action verbs (P2) -- they clear the contract gate', async () => {
    // Schema rejection proves it got PAST the contract check to the zod gate.
    const replies = await run({ requestId: 'v3', name: 'dispatch', args: {} }, CONTROL_PANEL)
    expect(String(replies[0].error)).toContain('invalid args')
    expect(String(replies[0].error)).not.toContain('not in the voice contract')
  })

  it('carries a cost-gate release through: an unknown decision is refused, not executed', async () => {
    const replies = await run(
      { requestId: 'v3b', name: 'confirm_expensive', args: { decisionId: 'dec_nope', confirm: true } },
      CONTROL_PANEL,
    )
    expect(replies[0]).toMatchObject({ ok: false, name: 'confirm_expensive' })
    expect(String(replies[0].error)).toContain('unknown decision')
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
