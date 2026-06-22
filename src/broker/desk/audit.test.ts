import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DispatchDecision } from '../../shared/protocol'
import { closeDispatchAudit, getDecision, initDispatchAudit, listDecisions, recordDecision } from './audit'

let dir: string

function decision(over: Partial<DispatchDecision> = {}): DispatchDecision {
  return {
    type: 'dispatch_decision',
    decisionId: `dec_${crypto.randomUUID()}`,
    intent: 'fix the mic bug',
    disposition: 'route',
    target: 'conv_abc',
    confidence: 0.82,
    reasoning: 'matches the active mic conversation',
    executed: true,
    traceId: 'trc_1',
    ts: 1000,
    ...over,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-audit-'))
  initDispatchAudit(dir)
})

afterEach(() => {
  closeDispatchAudit()
  rmSync(dir, { recursive: true, force: true })
})

describe('dispatch audit store', () => {
  it('records and reads back a decision', () => {
    const d = decision()
    recordDecision(d)
    const got = getDecision(d.decisionId)
    expect(got).not.toBeNull()
    expect(got?.intent).toBe('fix the mic bug')
    expect(got?.disposition).toBe('route')
    expect(got?.target).toBe('conv_abc')
    expect(got?.executed).toBe(true)
  })

  it('round-trips candidates + cost JSON', () => {
    const d = decision({
      disposition: 'ask',
      target: undefined,
      executed: false,
      candidates: [{ conversationId: 'conv_x', commentary: 'recent mic work', score: 0.7 }],
      cost: { tier: 'very_expensive', contextTokens: 180_000, coldCache: true, model: 'opus' },
      awaitingConfirmation: true,
    })
    recordDecision(d)
    const got = getDecision(d.decisionId)
    expect(got?.candidates?.[0]?.conversationId).toBe('conv_x')
    expect(got?.cost?.tier).toBe('very_expensive')
    expect(got?.cost?.coldCache).toBe(true)
    expect(got?.awaitingConfirmation).toBe(true)
    expect(got?.target).toBeUndefined()
  })

  it('upserts by decisionId (ask -> executed)', () => {
    const d = decision({ disposition: 'ask', executed: false })
    recordDecision(d)
    recordDecision({ ...d, disposition: 'route', executed: true, resultConversationId: 'conv_done' })
    const got = getDecision(d.decisionId)
    expect(got?.executed).toBe(true)
    expect(got?.disposition).toBe('route')
    expect(got?.resultConversationId).toBe('conv_done')
    expect(listDecisions()).toHaveLength(1) // upsert, not a second row
  })

  it('lists most-recent first, respecting limit', () => {
    recordDecision(decision({ ts: 100 }))
    recordDecision(decision({ ts: 300 }))
    recordDecision(decision({ ts: 200 }))
    const all = listDecisions()
    expect(all.map(d => d.ts)).toEqual([300, 200, 100])
    expect(listDecisions(2)).toHaveLength(2)
  })
})
