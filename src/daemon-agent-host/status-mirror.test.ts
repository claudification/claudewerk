import { describe, expect, it } from 'bun:test'
import type { ConversationStatusSignal, DaemonBlockObserved, DaemonStatePatch } from '../shared/protocol'
import { type MirrorState, translatePatch } from './status-mirror'

const CONV = 'conv_abc123'
const T = 1779536625072

type AnyMsg = { type: string }

/** Find the one message of `type`, asserting it is present (so assertions need no `?.`). */
function must<T extends AnyMsg>(msgs: AnyMsg[], type: string): T {
  const m = msgs.find(x => x.type === type) as T | undefined
  if (!m) throw new Error(`expected a ${type} message, got [${msgs.map(x => x.type).join(', ')}]`)
  return m
}

/** True when no message of `type` is present. */
function absent(msgs: AnyMsg[], type: string): boolean {
  return !msgs.some(x => x.type === type)
}

describe('translatePatch', () => {
  it('ignores a pure {pid} patch (no meaningful field)', () => {
    const { messages, next } = translatePatch(CONV, { pid: 123 }, {}, T)
    expect(messages).toEqual([])
    expect(next).toEqual({})
  })

  it('emits a daemon_state_patch + conversation_status for a working patch', () => {
    const patch = { state: 'working', detail: 'running echo SPIKE_OK', tempo: 'idle', needs: '' }
    const { messages, next } = translatePatch(CONV, patch, {}, T)

    const sp = must<DaemonStatePatch>(messages, 'daemon_state_patch')
    expect(sp.state).toBe('working')
    expect(sp.tempo).toBe('idle')
    expect(sp.detail).toBe('running echo SPIKE_OK')
    expect(sp.needs).toBe('')
    expect(sp.raw).toEqual(patch)
    expect(sp.t).toBe(T)

    const cs = must<ConversationStatusSignal>(messages, 'conversation_status')
    expect(cs.status).toBe('active') // working -> active
    expect(cs.daemonState).toBe('working')
    expect(cs.detail).toBe('running echo SPIKE_OK')

    expect(next).toEqual({ state: 'working', tempo: 'idle', detail: 'running echo SPIKE_OK' })
  })

  it('maps terminal states (done) to idle', () => {
    const { messages } = translatePatch(CONV, { state: 'done' }, {}, T)
    const cs = must<ConversationStatusSignal>(messages, 'conversation_status')
    expect(cs.status).toBe('idle')
    expect(cs.daemonState).toBe('done')
  })

  it('maps failed/crashed to idle too', () => {
    for (const state of ['failed', 'crashed']) {
      const cs = must<ConversationStatusSignal>(translatePatch(CONV, { state }, {}, T).messages, 'conversation_status')
      expect(cs.status).toBe('idle')
    }
  })

  it('dedups conversation_status when state/tempo/detail are unchanged', () => {
    const prev: MirrorState = { state: 'working', tempo: 'active', detail: 'thinking' }
    const { messages } = translatePatch(CONV, { detail: 'thinking' }, prev, T)
    expect(absent(messages, 'conversation_status')).toBe(true)
    expect(absent(messages, 'daemon_state_patch')).toBe(false)
  })

  it('emits a new conversation_status when the detail changes', () => {
    const prev: MirrorState = { state: 'working', tempo: 'active', detail: 'thinking' }
    const { messages, next } = translatePatch(CONV, { detail: 'running tests' }, prev, T)
    const cs = must<ConversationStatusSignal>(messages, 'conversation_status')
    expect(cs.detail).toBe('running tests')
    expect(cs.daemonState).toBe('working') // carried from prev
    expect(next.detail).toBe('running tests')
  })

  it('emits daemon_block_observed when state is blocked', () => {
    const { messages } = translatePatch(CONV, { state: 'blocked', needs: 'allow Bash echo?' }, {}, T)
    const blk = must<DaemonBlockObserved>(messages, 'daemon_block_observed')
    expect(blk.needs).toBe('allow Bash echo?')
  })

  it('extracts requestId from a block:{requestId} patch (defensive shape)', () => {
    const patch = { state: 'blocked', block: { requestId: 'req_xyz', kind: 'permission' } }
    const { messages } = translatePatch(CONV, patch, {}, T)
    const blk = must<DaemonBlockObserved>(messages, 'daemon_block_observed')
    expect(blk.requestId).toBe('req_xyz')
    expect(blk.raw).toEqual({ block: { requestId: 'req_xyz', kind: 'permission' } })
  })

  it('does NOT emit daemon_block_observed for a non-blocking needs:""', () => {
    const { messages } = translatePatch(CONV, { state: 'working', needs: '' }, {}, T)
    expect(absent(messages, 'daemon_block_observed')).toBe(true)
  })
})
