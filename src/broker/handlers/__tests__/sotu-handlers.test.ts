import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerContext, MessageData, WsData } from '../../handler-context'
import { routeMessage } from '../../message-router'
import { initSotuStore, projectSlug } from '../../sotu'
import { readQueue } from '../../sotu/queue'
import { registerSotuHandlers } from '../sotu'

// Phase 3 turn_digest + Phase 1 scribe_note share the benevolent gate + the
// recordContribution chokepoint + the sotu_contribution broadcast. These tests
// prove the gate, the queue append, and the broadcast for the new turn_digest
// path (and that scribe_note still works after the shared-helper refactor).

const PROJECT = 'claude://host/proj'

beforeAll(() => {
  registerSotuHandlers()
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-handlers-'))
  initSotuStore(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function settings(trustLevel: 'default' | 'benevolent'): HandlerContext['callerSettings'] {
  return { trustLevel } as unknown as HandlerContext['callerSettings']
}

interface RunResult {
  replies: Record<string, unknown>[]
  broadcasts: { msg: Record<string, unknown>; project: string }[]
}

function run(
  type: string,
  data: MessageData,
  wsData: Partial<WsData>,
  callerSettings?: HandlerContext['callerSettings'],
): RunResult {
  const replies: Record<string, unknown>[] = []
  const broadcasts: RunResult['broadcasts'] = []
  const ctx = {
    ws: { data: wsData },
    callerSettings: callerSettings ?? null,
    reply: (m: Record<string, unknown>) => replies.push(m),
    broadcastScoped: (msg: Record<string, unknown>, project: string) => broadcasts.push({ msg, project }),
    conversations: { getConversation: (id: string) => (id ? { project: PROJECT } : undefined) },
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  routeMessage(ctx, type, data)
  return { replies, broadcasts }
}

describe('turn_digest handler', () => {
  it('rejects a non-benevolent agent-host with a clean error + requestId', () => {
    const { replies } = run(
      'turn_digest',
      { requestId: 'td-1', convId: 'conv-a', intent: 'x' },
      {},
      settings('default'),
    )
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'turn_digest_result', ok: false, requestId: 'td-1' })
    expect(replies[0].error).toBe('Requires benevolent trust level')
  })

  it('records a benevolent turn_digest to the queue + broadcasts + acks', () => {
    const { replies, broadcasts } = run(
      'turn_digest',
      {
        requestId: 'td-2',
        convId: 'conv-a',
        intent: 'wire phase 3',
        touching: ['src/a.ts', 'src/b.ts'],
        result: 'success',
      },
      { conversationId: 'conv-a' },
      settings('benevolent'),
    )
    expect(replies[0]).toMatchObject({ type: 'turn_digest_result', ok: true, requestId: 'td-2' })

    const q = readQueue(projectSlug(PROJECT))
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({
      kind: 'turn_digest',
      convId: 'conv-a',
      intent: 'wire phase 3',
      touching: ['src/a.ts', 'src/b.ts'],
      result: 'success',
    })

    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].project).toBe(PROJECT)
    expect(broadcasts[0].msg).toMatchObject({
      type: 'sotu_contribution',
      project: PROJECT,
      pendingContribs: 1, // turn_digest weighs 1 (baseline floor)
      latest: { convId: 'conv-a', kind: 'turn_digest' },
    })
  })

  it('drops empty optional fields (no bogus undefined in the queue entry)', () => {
    run(
      'turn_digest',
      { convId: 'conv-a', intent: 'only intent', touching: [] },
      { conversationId: 'conv-a' },
      settings('benevolent'),
    )
    const q = readQueue(projectSlug(PROJECT))
    expect(q[0]).toMatchObject({ kind: 'turn_digest', intent: 'only intent' })
    expect('touching' in q[0]).toBe(false)
    expect('result' in q[0]).toBe(false)
  })

  it('rejects when no conversation/project can be resolved', () => {
    const { replies } = run('turn_digest', { intent: 'x' }, {}, settings('benevolent'))
    expect(replies[0]).toMatchObject({ type: 'turn_digest_result', ok: false })
    expect(replies[0].error).toBe('no resolvable conversation/project')
  })
})

describe('scribe_note handler still works after the shared-helper refactor', () => {
  it('records a benevolent callout + broadcasts kind=callout', () => {
    const { replies, broadcasts } = run(
      'scribe_note',
      { convId: 'conv-a', noteType: 'lock', payload: 'refactoring x', target: { kind: 'claim', path: 'src/x.ts' } },
      { conversationId: 'conv-a' },
      settings('benevolent'),
    )
    expect(replies[0]).toMatchObject({ type: 'scribe_note_result', ok: true, pendingContribs: 3 })
    const q = readQueue(projectSlug(PROJECT))
    expect(q[0]).toMatchObject({ kind: 'callout', type: 'lock', payload: 'refactoring x', weight: 'high' })
    expect(broadcasts[0].msg).toMatchObject({ latest: { kind: 'callout' } })
  })

  it('rejects a missing noteType/payload', () => {
    const { replies } = run('scribe_note', { convId: 'conv-a' }, { conversationId: 'conv-a' }, settings('benevolent'))
    expect(replies[0]).toMatchObject({ type: 'scribe_note_result', ok: false })
    expect(replies[0].error).toBe('scribe_note requires noteType + payload')
  })
})
