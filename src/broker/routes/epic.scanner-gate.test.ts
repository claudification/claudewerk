/**
 * ARMING IS THE OTHER CALLER.
 *
 * The sweep drops an armed run in a project that never ticked the "epics" box, so
 * without this gate `start` would report success and the run would sit `armed`
 * forever with nothing coming to beat it. Refusing at the arm is the same check,
 * told at the one moment a human can act on it.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { ConversationStore } from '../conversation-store'
import { initProjectSettings, setProjectSettings } from '../project-settings'
import type { KVStore } from '../store/types'
import { createEpicRouter } from './epic'

const PROJECT = 'claude://default/Users/jonas/projects/demo'

function memoryKv(): KVStore {
  const map = new Map<string, unknown>()
  return {
    get: <T>(key: string) => (map.get(key) as T) ?? null,
    set: (key, value) => void map.set(key, value),
    delete: (key: string) => map.delete(key),
    keys: () => [...map.keys()],
  }
}

/** No sentinel connected, which is enough: every op that gets PAST the gate
 *  fails with "no sentinel", and that failure is the proof it got past. */
const store = {
  getSentinel: () => undefined,
  getSentinelByAlias: () => undefined,
  addProjectListener: () => {},
  removeProjectListener: () => {},
} as unknown as ConversationStore

const router = () => createEpicRouter(store, { httpHasPermission: () => true })

async function post(body: object): Promise<Response> {
  return router().request('/api/epic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  initProjectSettings(memoryKv())
  setProjectSettings(PROJECT, { scanners: undefined })
})

describe('POST /api/epic start -- the opt-in gate', () => {
  test('refuses to arm a run in a project with the "epics" box unticked', async () => {
    const res = await post({ project: PROJECT, op: 'start', epicId: 'e1' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('would never be swept')
    expect(body.error).toContain('Project Settings > Scanners')
  })

  test('lets the arm through once the box is ticked', async () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    const res = await post({ project: PROJECT, op: 'start', epicId: 'e1' })
    // Past the gate and out to the sentinel, which is not connected in a test.
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('no sentinel')
  })

  test('does NOT gate the ops that stop a run -- pause must work in an opted-out project', async () => {
    // Switching the scanner off must never strand a run somebody wants to abort.
    const res = await post({ project: PROJECT, op: 'pause', epicId: 'e1' })
    expect(res.status).toBe(502)
  })

  test('does NOT gate reads -- `get` still answers for an opted-out project', async () => {
    const res = await post({ project: PROJECT, op: 'get', epicId: 'e1' })
    expect(res.status).toBe(502)
  })
})
