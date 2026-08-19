/**
 * The push-notification answer path: POST /api/permissions/respond.
 *
 * This is the route a service worker hits when someone taps Allow on a locked
 * phone, so its gates matter more than most -- it must refuse a caller without
 * `chat` on the project, and it must go through the same resolver the panel
 * uses rather than a second copy of the logic.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { ConversationStore } from '../conversation-store'
import { createPermissionsRouter } from './permissions'
import type { RouteHelpers } from './shared'

const PROJECT = 'claude:///home/user/proj'
const HEADERS = { 'Content-Type': 'application/json' }

let hostSends: string[] = []
let resolveCalls: unknown[] = []

function makeApp(opts?: { denyPermission?: boolean; noConversation?: boolean; noPending?: boolean }) {
  hostSends = []
  resolveCalls = []
  const conversation = {
    id: 'conv-1',
    project: PROJECT,
    pendingPermission: opts?.noPending
      ? undefined
      : { requestId: 'req-1', toolName: 'Bash', timestamp: Date.now() - 5_000, toolUseId: 'tu-1' },
    pendingAttention: { type: 'permission' as const, toolName: 'Bash', timestamp: Date.now() },
  }
  const store = {
    getConversation: () => (opts?.noConversation ? undefined : conversation),
    getConversationSocket: () => ({ send: (s: string) => hostSends.push(s) }),
    persistConversationById: () => {},
    broadcastConversationUpdate: () => {},
    broadcastConversationScoped: (msg: unknown) => resolveCalls.push(msg),
    addTranscriptEntries: (_id: string, entries: unknown[]) => entries,
    broadcastToChannel: () => {},
  } as unknown as ConversationStore
  const helpers = { httpHasPermission: () => !opts?.denyPermission } as unknown as RouteHelpers
  return createPermissionsRouter(store, helpers)
}

function respond(app: ReturnType<typeof makeApp>, body: Record<string, unknown>) {
  return app.request('/api/permissions/respond', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
}

beforeEach(() => {
  hostSends = []
  resolveCalls = []
})

describe('POST /api/permissions/respond', () => {
  test('forwards the answer to the agent host and reports it resolved', async () => {
    const app = makeApp()
    const res = await respond(app, { conversationId: 'conv-1', requestId: 'req-1', behavior: 'allow' })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, resolved: true, forwarded: true })
    expect(hostSends).toHaveLength(1)
    const sent = JSON.parse(hostSends[0])
    expect(sent).toMatchObject({ type: 'permission_response', requestId: 'req-1', behavior: 'allow' })
  })

  test('a deny is forwarded as a deny, not coerced to allow', async () => {
    const app = makeApp()
    await respond(app, { conversationId: 'conv-1', requestId: 'req-1', behavior: 'deny' })
    expect(JSON.parse(hostSends[0]).behavior).toBe('deny')
  })

  test('rejects a caller without chat permission on the project', async () => {
    const app = makeApp({ denyPermission: true })
    const res = await respond(app, { conversationId: 'conv-1', requestId: 'req-1', behavior: 'allow' })

    expect(res.status).toBe(403)
    expect(hostSends).toHaveLength(0)
  })

  test('rejects an unknown conversation', async () => {
    const app = makeApp({ noConversation: true })
    const res = await respond(app, { conversationId: 'nope', requestId: 'req-1', behavior: 'allow' })
    expect(res.status).toBe(404)
  })

  test('rejects a malformed behavior instead of guessing', async () => {
    const app = makeApp()
    const res = await respond(app, { conversationId: 'conv-1', requestId: 'req-1', behavior: 'maybe' })
    expect(res.status).toBe(400)
    expect(hostSends).toHaveLength(0)
  })

  test('reports resolved:false when the panel already answered', async () => {
    const app = makeApp({ noPending: true })
    const res = await respond(app, { conversationId: 'conv-1', requestId: 'req-1', behavior: 'allow' })

    // Still a 200: a late tap is not an error, it just did not decide anything.
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, resolved: false })
  })
})
