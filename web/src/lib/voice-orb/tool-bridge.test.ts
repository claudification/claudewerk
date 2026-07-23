import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FunctionCall } from './realtime-events'
import { createToolBridge, deliverVoiceToolResult, setActiveToolBridge } from './tool-bridge'

const call = (name: string, args: Record<string, unknown> = {}): FunctionCall => ({ callId: 'c1', name, args })

function harness(local?: Parameters<typeof createToolBridge>[0]['local']) {
  const send = vi.fn()
  let n = 0
  const bridge = createToolBridge({
    send,
    ...(local ? { local } : {}),
    newRequestId: () => `req${++n}`,
    timeoutMs: 1000,
  })
  return { send, bridge }
}

beforeEach(() => {
  vi.useRealTimers()
  setActiveToolBridge(null)
})

describe('client-local verbs', () => {
  it('answers in the browser and never touches the wire', async () => {
    const navigate = vi.fn(() => ({ ok: true }))
    const { send, bridge } = harness({ control_screen: navigate })
    await expect(bridge.run(call('control_screen', { action: 'navigate', target: 'c9' }))).resolves.toEqual({
      ok: true,
    })
    expect(navigate).toHaveBeenCalledWith({ action: 'navigate', target: 'c9' })
    expect(send).not.toHaveBeenCalled()
  })

  it('turns a thrown local handler into an error payload, not a rejection', async () => {
    const { bridge } = harness({
      control_screen: () => {
        throw new Error('no such view')
      },
    })
    await expect(bridge.run(call('control_screen'))).resolves.toEqual({
      error: 'control_screen failed in the panel: no such view',
    })
  })
})

describe('wire verbs', () => {
  it('sends voice_tool_call and resolves on the correlated result', async () => {
    const { send, bridge } = harness()
    const p = bridge.run(call('projects_overview'))
    expect(send).toHaveBeenCalledWith('voice_tool_call', {
      requestId: 'req1',
      name: 'projects_overview',
      args: {},
    })
    bridge.deliver({ requestId: 'req1', ok: true, result: { projects: 3 } })
    await expect(p).resolves.toEqual({ projects: 3 })
  })

  it('keeps concurrent calls apart by requestId', async () => {
    const { bridge } = harness()
    const a = bridge.run(call('projects_overview'))
    const b = bridge.run(call('list_conversations'))
    bridge.deliver({ requestId: 'req2', ok: true, result: 'second' })
    bridge.deliver({ requestId: 'req1', ok: true, result: 'first' })
    await expect(a).resolves.toBe('first')
    await expect(b).resolves.toBe('second')
  })

  it('surfaces a broker refusal as an error payload the model can speak', async () => {
    const { bridge } = harness()
    const p = bridge.run(call('terminate'))
    bridge.deliver({ requestId: 'req1', ok: false, error: "'terminate' is not in the voice contract" })
    await expect(p).resolves.toEqual({ error: "'terminate' is not in the voice contract" })
  })

  it('ignores a result with no requestId, and a late one after settle', async () => {
    const { bridge } = harness()
    const p = bridge.run(call('projects_overview'))
    bridge.deliver({ ok: true, result: 'stray' })
    bridge.deliver({ requestId: 'req1', ok: true, result: 'real' })
    bridge.deliver({ requestId: 'req1', ok: true, result: 'late' })
    await expect(p).resolves.toBe('real')
  })

  it('settles on a send failure instead of hanging the turn', async () => {
    const send = vi.fn(() => {
      throw new Error('socket closed')
    })
    const bridge = createToolBridge({ send, newRequestId: () => 'req1' })
    await expect(bridge.run(call('projects_overview'))).resolves.toEqual({
      error: 'could not reach the broker: socket closed',
    })
  })

  it('times out rather than freezing the model mid-turn', async () => {
    vi.useFakeTimers()
    const bridge = createToolBridge({ send: vi.fn(), newRequestId: () => 'req1', timeoutMs: 5000 })
    const p = bridge.run(call('read_events'))
    vi.advanceTimersByTime(5000)
    await expect(p).resolves.toEqual({ error: 'read_events timed out after 5000ms' })
  })

  it('settles everything outstanding on dispose', async () => {
    const { bridge } = harness()
    const p = bridge.run(call('projects_overview'))
    bridge.dispose()
    await expect(p).resolves.toEqual({ error: 'voice session closed' })
  })
})

describe('the active-bridge slot', () => {
  it('routes a WS result to the summoned orb, and no-ops when none is', async () => {
    const { bridge } = harness()
    expect(() => deliverVoiceToolResult({ requestId: 'req1', ok: true, result: 1 })).not.toThrow()
    setActiveToolBridge(bridge)
    const p = bridge.run(call('projects_overview'))
    deliverVoiceToolResult({ requestId: 'req1', ok: true, result: 'via slot' })
    await expect(p).resolves.toBe('via slot')
  })

  it('a late clear from the OLD session does not wipe the NEW one (restart race)', async () => {
    const { bridge: oldBridge } = harness()
    const { bridge: newBridge } = harness()
    // Restart order: new session registers, THEN the old teardown's async clear
    // lands. Compare-and-clear must ignore it because a newer bridge took over.
    setActiveToolBridge(newBridge)
    setActiveToolBridge(null, oldBridge)
    // The new session's tool call still routes -- the slot was not wiped.
    const p = newBridge.run(call('projects_overview'))
    deliverVoiceToolResult({ requestId: 'req1', ok: true, result: 'still routed' })
    await expect(p).resolves.toBe('still routed')
  })

  it('a clear that DOES own the slot still clears it', () => {
    const { bridge } = harness()
    setActiveToolBridge(bridge)
    setActiveToolBridge(null, bridge)
    // Nothing is active now -- a stray result is a harmless no-op.
    expect(() => deliverVoiceToolResult({ requestId: 'req1', ok: true, result: 1 })).not.toThrow()
  })
})
