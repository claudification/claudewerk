/**
 * `POST /api/epic-seat` -- the parse and the gate.
 *
 * The route's whole job is three fields and a permission question that can only
 * be asked once the CALLER'S OWN conversation has been resolved to a project.
 * The claim itself is proven in `epic-seat-claim.test.ts`; what matters here is
 * that a request carrying a project or an epic id cannot influence any of it.
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationStore } from '../conversation-store'
import { createEpicSeatRouter } from './epic-seat'

/** No sentinel connected, which is enough: anything that reaches the substrate
 *  fails with "no sentinel", and that failure is the proof it got past. */
const store = {
  getSentinel: () => undefined,
  getSentinelByAlias: () => undefined,
  addProjectListener: () => {},
  removeProjectListener: () => {},
  getAllConversations: () => [],
  getConversations: () => [],
} as unknown as ConversationStore

async function post(body: object, allow = true): Promise<Response> {
  return createEpicSeatRouter(store, { httpHasPermission: () => allow }).request('/api/epic-seat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/epic-seat', () => {
  test('a request with no conversationId is refused before anything is looked up', async () => {
    const res = await post({ action: 'claim' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('conversationId')
  })

  test('an action that is neither claim nor release is refused', async () => {
    const res = await post({ conversationId: 'conv_a', action: 'steal' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('claim or release')
  })

  /** The route never learns a project or an epic id from the request. A caller
   *  that sends them is claiming its OWN seat or nothing. */
  test('a conversation the broker does not know is refused, whatever the body claims', async () => {
    const res = await post({
      conversationId: 'conv_ghost',
      action: 'claim',
      project: 'claude://default/somewhere/else',
      epicId: 'somebody-elses-epic',
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { ok: boolean; outcome: string; exit?: true }
    expect(body.ok).toBe(false)
    expect(body.outcome).toBe('error')
    // Not a collision, so nothing is told to exit.
    expect(body.exit).toBeUndefined()
  })
})
