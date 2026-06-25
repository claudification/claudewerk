import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the WS seam so the store can be exercised without a live socket.
const { wsSend } = vi.hoisted(() => ({ wsSend: vi.fn(() => true) }))
vi.mock('@/hooks/use-conversations', () => ({
  wsSend,
  useConversationsStore: { getState: () => ({ selectConversation: vi.fn() }) },
}))
vi.mock('./dispatch-bus', () => ({ dispatchBus: { open: vi.fn(), useArmed: () => true } }))

import type { DispatchCandidate, DispatchDecision } from '@shared/protocol'
import { useDispatchStore } from './dispatch-store'

describe('dispatch submit hardening (defect #2)', () => {
  beforeEach(() => {
    wsSend.mockReset()
    wsSend.mockReturnValue(true)
    useDispatchStore.setState({ intent: '', pending: false, lastError: null })
  })

  it('does NOT throw when intent is undefined (the stale-bundle bug)', () => {
    // Reproduce the deployed-bundle condition: `intent` missing from the store.
    useDispatchStore.setState({ intent: undefined as unknown as string })
    expect(() => useDispatchStore.getState().submit()).not.toThrow()
    expect(wsSend).not.toHaveBeenCalled() // empty intent -> nothing sent
  })

  it('sends dispatch_request for a real intent and clears the draft', () => {
    useDispatchStore.setState({ intent: '  hi there  ' })
    useDispatchStore.getState().submit()
    expect(wsSend).toHaveBeenCalledWith('dispatch_request', expect.objectContaining({ intent: 'hi there' }))
    expect(useDispatchStore.getState().intent).toBe('')
  })

  it('surfaces a thrown error as lastError instead of dying silently', () => {
    wsSend.mockImplementation(() => {
      throw new Error('ws boom')
    })
    useDispatchStore.setState({ intent: 'hello' })
    expect(() => useDispatchStore.getState().submit()).not.toThrow()
    expect(useDispatchStore.getState().lastError).toBe('ws boom')
    expect(useDispatchStore.getState().pending).toBe(false)
  })
})

// The DEAD-INPUT bug: `wsSend` returns false and SILENTLY DROPS when the socket
// isn't OPEN. Because `pending`/`threadsLoading` are only ever cleared by an
// INBOUND reply, optimistically entering them on a dropped send wedges the flag
// true forever -> every future submit is gated off (input looks dead, nothing
// reacts). These lock the anti-brick contract: a dropped send must stay fully
// recoverable -- no stuck pending, draft preserved, failure surfaced.
describe('anti-brick: a dropped wsSend (socket not OPEN) never wedges the cockpit', () => {
  beforeEach(() => {
    wsSend.mockReset()
    wsSend.mockReturnValue(false) // socket NOT open -> every send is dropped
    useDispatchStore.setState({ intent: '', pending: false, lastError: null, threadsLoading: false, decisions: [] })
  })

  it('submit keeps the draft, leaves pending false, and surfaces a connection error', () => {
    useDispatchStore.setState({ intent: 'do a thing' })
    useDispatchStore.getState().submit()
    expect(wsSend).toHaveBeenCalledWith('dispatch_request', expect.objectContaining({ intent: 'do a thing' }))
    expect(useDispatchStore.getState().intent).toBe('do a thing') // NOT cleared -- the user keeps their text
    expect(useDispatchStore.getState().pending).toBe(false) // NOT wedged
    expect(useDispatchStore.getState().lastError).toMatch(/not connected/i)
  })

  it('a dropped submit does NOT brick the next submit once the socket is back', () => {
    useDispatchStore.setState({ intent: 'first' })
    useDispatchStore.getState().submit() // dropped
    expect(useDispatchStore.getState().pending).toBe(false)

    wsSend.mockReturnValue(true) // reconnected
    useDispatchStore.setState({ intent: 'second' })
    useDispatchStore.getState().submit()
    expect(wsSend).toHaveBeenLastCalledWith('dispatch_request', expect.objectContaining({ intent: 'second' }))
    expect(useDispatchStore.getState().intent).toBe('') // cleared on a REAL send
    expect(useDispatchStore.getState().pending).toBe(true)
  })

  it('fetchThreads only enters the loading state when the request actually went out', () => {
    useDispatchStore.getState().fetchThreads() // dropped
    expect(wsSend).toHaveBeenCalledWith('dispatch_list_threads', expect.anything())
    expect(useDispatchStore.getState().threadsLoading).toBe(false) // not wedged on "loading"

    wsSend.mockReturnValue(true)
    useDispatchStore.getState().fetchThreads()
    expect(useDispatchStore.getState().threadsLoading).toBe(true)
  })

  it('confirmExpensive does not set pending when the send is dropped', () => {
    const decision = { intent: 'redo', target: 'conv_x', disposition: 'route' } as unknown as DispatchDecision
    useDispatchStore.getState().confirmExpensive(decision)
    expect(useDispatchStore.getState().pending).toBe(false)
    expect(useDispatchStore.getState().lastError).toMatch(/not connected/i)
  })

  it('chooseCandidate does not set pending when the send is dropped', () => {
    useDispatchStore.setState({ intent: 'go' })
    const candidate = { conversationId: 'conv_y' } as unknown as DispatchCandidate
    useDispatchStore.getState().chooseCandidate(candidate, false)
    expect(useDispatchStore.getState().pending).toBe(false)
  })
})

// The other dead-on-open path: a thrown desk-load handler (e.g. the `spawn`
// permission gate) comes back as `dispatch_list_threads_result` ok:false. The
// reducer must clear loading + surface it WITHOUT wiping the desk to blanks.
describe('desk-load failure clears loading instead of wedging', () => {
  beforeEach(() => {
    wsSend.mockReset()
    wsSend.mockReturnValue(true)
    useDispatchStore.setState({ threadsLoading: true, lastError: null, roster: [], memory: '' })
  })

  it('onThreadsResult ok:false clears threadsLoading + surfaces the error, keeping prior desk state', () => {
    useDispatchStore.setState({ roster: [{ conversationId: 'c1' } as unknown as DispatchCandidate] })
    useDispatchStore.getState().onThreadsResult({ ok: false, error: 'Forbidden: spawn not allowed' })
    expect(useDispatchStore.getState().threadsLoading).toBe(false)
    expect(useDispatchStore.getState().lastError).toBe('Forbidden: spawn not allowed')
    expect(useDispatchStore.getState().roster).toHaveLength(1) // NOT wiped to blanks
  })

  it('onThreadsResult success applies the desk and clears loading', () => {
    useDispatchStore
      .getState()
      .onThreadsResult({ roster: [{ conversationId: 'c2' } as unknown as DispatchCandidate], memory: 'remember' })
    expect(useDispatchStore.getState().threadsLoading).toBe(false)
    expect(useDispatchStore.getState().roster).toHaveLength(1)
    expect(useDispatchStore.getState().memory).toBe('remember')
  })
})
