/**
 * The rule that decides whether a reconnect forces an immediate read.
 *
 * The detail pane used to refresh on a bare 20s interval that knew nothing about
 * the socket or the tab, so a panel that had been disconnected -- or asleep --
 * for hours showed old numbers while its own header read "beat 11s ago". An
 * unattended run is exactly the thing you leave open and glance at later, so
 * that is the case that mattered most.
 */

import { describe, expect, it } from 'vitest'
import { shouldRefetchOnReconnect } from './use-overseer-inspect'

const state = (over: Partial<Parameters<typeof shouldRefetchOnReconnect>[0]> = {}) => ({
  connected: true,
  project: 'claude://s/p',
  epicId: 'epic-the-wall',
  hidden: false,
  ...over,
})

describe('shouldRefetchOnReconnect', () => {
  it('reads immediately when a visible pane regains the socket', () => {
    expect(shouldRefetchOnReconnect(state())).toBe(true)
  })

  it('does not read while still disconnected -- there is nothing to ask', () => {
    expect(shouldRefetchOnReconnect(state({ connected: false }))).toBe(false)
  })

  /** A background tab reconnecting is not somebody looking. The visibility
   *  handler reads the moment it becomes one, so reading here would just pay for
   *  an expensive inspect nobody sees. */
  it('does not read while the tab is hidden', () => {
    expect(shouldRefetchOnReconnect(state({ hidden: true }))).toBe(false)
  })

  it('does not read with no run selected', () => {
    expect(shouldRefetchOnReconnect(state({ epicId: null }))).toBe(false)
    expect(shouldRefetchOnReconnect(state({ project: null }))).toBe(false)
  })

  it('needs every condition at once, not any of them', () => {
    expect(shouldRefetchOnReconnect(state({ connected: false, hidden: true, epicId: null }))).toBe(false)
  })
})
