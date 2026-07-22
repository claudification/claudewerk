/**
 * Regression test for the setTimeout leak fix at settings-page.tsx:879.
 *
 * When the settings dialog opens a 50ms setTimeout is scheduled to focus
 * the filter input. If the component unmounts before the timer fires the
 * timer was left dangling. The fix captures the id and clears it on
 * cleanup. We verify that clearTimeout is called with that timer's id.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
// Static, not `await import()` inside the test. vi.mock is hoisted above this,
// so the mocks still apply -- and settings-page's module graph costs several
// seconds to transform on a cold run, which blew the 5s per-test timeout when
// that cost sat inside the test body.
import { SettingsDialog } from './settings-page'

const STORE_STATE = {
  conversations: [],
  projectSettings: {},
  globalSettings: {},
  controlPanelPrefs: { settingsTab: 'general' },
  updateControlPanelPrefs: vi.fn(),
}
vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: Object.assign((selector: (s: unknown) => unknown) => selector(STORE_STATE), {
    getState: () => STORE_STATE,
  }),
  useConversations: () => STORE_STATE.conversations,
  wsSend: vi.fn(),
}))

vi.mock('@/hooks/use-voice-recording', () => ({
  invalidateWarmStream: vi.fn(),
}))

vi.mock('@/lib/utils', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    haptic: vi.fn(),
    clearCacheAndReload: vi.fn(),
    cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('SettingsDialog setTimeout cleanup', () => {
  // 30s, not the 5s default. SettingsDialog is a heavy render and this file runs
  // alongside 158 others -- under that parallel load the single render pushed
  // past 5s and the file failed, while passing in isolation. The timeout is the
  // honest knob here: nothing is hanging, the work is just genuinely slow.
  test('clears the 50ms filter-focus timer when unmounted before it fires', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { unmount } = render(<SettingsDialog open={true} onOpenChange={vi.fn()} />)
    // Locate the 50ms focus timer the dialog scheduled.
    const focusCall = setTimeoutSpy.mock.calls.findIndex(c => c[1] === 50)
    expect(focusCall).toBeGreaterThanOrEqual(0)
    const focusTimerId = setTimeoutSpy.mock.results[focusCall].value
    unmount()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(focusTimerId)
  }, 30_000)
})
