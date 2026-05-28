/**
 * Regression test for the setTimeout leak fix at transcript-search.tsx:344.
 *
 * When the search dialog opens a 50ms setTimeout is scheduled to focus the
 * input. If the component unmounts before the timer fires the timer was
 * left dangling. The fix captures the id and clears it on cleanup.
 *
 * The cleanup is verified by checking that no timers remain pending after
 * unmount.
 */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { executeCommand } from '@/lib/commands'

const STORE_STATE = {
  controlPanelPrefs: {},
  selectConversation: vi.fn(),
}
vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: Object.assign((selector: (s: unknown) => unknown) => selector(STORE_STATE), {
    getState: () => STORE_STATE,
  }),
}))

vi.mock('@/lib/utils', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, haptic: vi.fn(), cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('TranscriptSearch setTimeout cleanup', () => {
  test('clears the 50ms focus timer when unmounted before it fires', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { TranscriptSearch } = await import('./transcript-search')
    const { unmount } = render(<TranscriptSearch />)
    // Open the dialog -- schedules the 50ms focus setTimeout.
    act(() => {
      executeCommand('search-transcripts')
    })
    // Find the 50ms timer the dialog scheduled (others may exist from Radix etc).
    const focusCall = setTimeoutSpy.mock.calls.findIndex(c => c[1] === 50)
    expect(focusCall).toBeGreaterThanOrEqual(0)
    const focusTimerId = setTimeoutSpy.mock.results[focusCall].value
    unmount()
    // Cleanup must have called clearTimeout with the focus timer's id.
    expect(clearTimeoutSpy).toHaveBeenCalledWith(focusTimerId)
  })
})
