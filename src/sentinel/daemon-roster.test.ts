import { describe, expect, it } from 'bun:test'
import type { JobRecord } from '../shared/cc-daemon/types'
import { buildJobInfos, mintConversationId, stopDaemonRosterWatch } from './daemon-roster'

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  short: 'aeb185f9',
  sessionId: 'aeb185f9-c7c3-0000',
  cwd: '/tmp/work',
  state: 'working',
  ...over,
})

describe('mintConversationId', () => {
  it('produces a conv_-prefixed id', () => {
    expect(mintConversationId()).toMatch(/^conv_[\w-]{12}$/)
  })

  it('produces a fresh id each call', () => {
    expect(mintConversationId()).not.toBe(mintConversationId())
  })
})

describe('buildJobInfos', () => {
  it('mints a conversationId for an unseen daemon job', () => {
    const idMap: Record<string, string> = {}
    const { infos, mutated } = buildJobInfos([job()], idMap)
    expect(mutated).toBe(true)
    expect(infos).toHaveLength(1)
    expect(infos[0]?.conversationId).toMatch(/^conv_/)
    expect(idMap['aeb185f9-c7c3-0000']).toBe(infos[0]?.conversationId)
  })

  it('reuses the mapped conversationId for a known session', () => {
    const idMap = { 'aeb185f9-c7c3-0000': 'conv_existing0001' }
    const { infos, mutated } = buildJobInfos([job()], idMap)
    expect(mutated).toBe(false)
    expect(infos[0]?.conversationId).toBe('conv_existing0001')
  })

  it('keys identity by sessionId, not the daemon short id', () => {
    const idMap = { 'aeb185f9-c7c3-0000': 'conv_stable000001' }
    // Same session, different short (daemon reassigned it across a restart).
    const { infos } = buildJobInfos([job({ short: 'ffff0000' })], idMap)
    expect(infos[0]?.conversationId).toBe('conv_stable000001')
  })

  it('carries the daemon JobRecord fields through', () => {
    const { infos } = buildJobInfos([job({ state: 'done', detail: 'finished' })], {})
    expect(infos[0]?.state).toBe('done')
    expect(infos[0]?.detail).toBe('finished')
    expect(infos[0]?.short).toBe('aeb185f9')
  })

  it('skips malformed records missing short or sessionId', () => {
    const { infos } = buildJobInfos(
      [job(), job({ sessionId: '' }), { short: '', sessionId: 's', cwd: '/', state: 'idle' }],
      {},
    )
    expect(infos).toHaveLength(1)
  })
})

describe('stopDaemonRosterWatch', () => {
  it('is safe to call when no watch is running', () => {
    expect(() => stopDaemonRosterWatch()).not.toThrow()
  })
})
