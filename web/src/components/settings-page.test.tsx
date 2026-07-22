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
  test('clears the 50ms filter-focus timer when unmounted before it fires', async () => {
    // Import BEFORE the fake timers go in. settings-page is a large chunk, and
    // resolving it under fake timers made this test a load-sensitive flake: on a
    // busy full-suite run the dynamic import alone blew the 5s test timeout. The
    // timer under test is scheduled by render(), not by import, so nothing is lost.
    const { SettingsDialog } = await import('./settings-page')
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
    // 30s, not the 5s default: this mounts the whole settings dialog, one of the
    // largest chunks in the app. On a loaded full-suite run the import + render
    // alone blew 5s and the test failed as a timeout while asserting nothing
    // about speed. The timeout is a hang guard here, not a perf budget.
  }, 30_000)
})
