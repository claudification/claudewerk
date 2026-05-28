/**
 * @vitest-environment jsdom
 *
 * Regression test for the setTimeout leak fix at shared-conversation-view.tsx:35.
 *
 * After fetchTranscript resolves, a 200ms setTimeout is scheduled to bump
 * newDataSeq (to trigger scroll-to-bottom after the virtualizer measures).
 * If the component unmounts after the fetch resolves but before the
 * timer fires the callback writes to a store on an unmounted component.
 *
 * The fix tracks the timer in a ref and clears it on cleanup, plus uses
 * a `cancelled` flag to bail out of the fetch resolution path entirely.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const STORE_STATE = {
  conversations: [{ id: 'conv_a', title: 't' }],
  selectedConversationId: 'conv_a',
  isConnected: true,
  selectConversation: vi.fn(),
  setEvents: vi.fn(),
  setTranscript: vi.fn(),
  ws: null,
}
const setStateMock = vi.fn()

// Manually-resolved transcript promise so we can drive timing in the test.
let resolveTranscript: ((v: unknown) => void) | null = null

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: Object.assign((selector: (s: unknown) => unknown) => selector(STORE_STATE), {
    getState: () => STORE_STATE,
    setState: setStateMock,
  }),
  fetchConversationEvents: vi.fn().mockResolvedValue([]),
  fetchTranscript: vi.fn(
    () =>
      new Promise(r => {
        resolveTranscript = r
      }),
  ),
}))

vi.mock('@/hooks/use-websocket', () => ({
  useWebSocket: vi.fn(),
}))

vi.mock('@/components/conversation-detail', () => ({
  ConversationDetail: () => null,
}))

vi.mock('@/components/media-lightbox', () => ({
  MediaLightbox: () => null,
}))

vi.mock('@/lib/types', () => ({
  extractProjectLabel: () => 'p',
}))

beforeEach(() => {
  STORE_STATE.selectedConversationId = 'conv_a'
  STORE_STATE.isConnected = true
  resolveTranscript = null
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('SharedConversationView setTimeout cleanup', () => {
  test('does not bump newDataSeq if unmounted before the 200ms scroll-bump timer fires', async () => {
    const { SharedConversationView } = await import('./shared-conversation-view')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { unmount } = render(<SharedConversationView token="tok_x" />)
    expect(resolveTranscript).not.toBeNull()
    // Unmount BEFORE resolving the fetch -- the `cancelled` flag should
    // prevent the scroll-bump setTimeout from being scheduled at all.
    unmount()
    resolveTranscript?.({ entries: [] })
    // Flush microtasks so the .then() runs.
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(1000)
    expect(setStateMock).not.toHaveBeenCalled()
  })

  test('does not bump newDataSeq if unmounted after fetch resolves but before 200ms timer fires', async () => {
    const { SharedConversationView } = await import('./shared-conversation-view')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { unmount } = render(<SharedConversationView token="tok_x" />)
    expect(resolveTranscript).not.toBeNull()
    resolveTranscript?.({ entries: [] })
    // Flush microtasks: the .then() runs, schedules the 200ms timer.
    await Promise.resolve()
    await Promise.resolve()
    unmount()
    // Advance past the 200ms timer -- cleanup must have cleared it.
    vi.advanceTimersByTime(1000)
    expect(setStateMock).not.toHaveBeenCalled()
  })
})
