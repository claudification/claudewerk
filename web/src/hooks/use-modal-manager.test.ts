/**
 * Tests for the unified minimizable-modals manager.
 *
 * Pins the two behaviours the design hinges on: blocking modals never park, and
 * restore WARPS to the owning conversation before re-opening (the
 * restore-from-another-context case from plan-unified-modals.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/lib/types'
import { useConversationsStore } from './use-conversations'
import { getDetachedWindow, useModalManagerStore } from './use-modal-manager'

function conv(id: string): Conversation {
  return {
    id,
    project: '/home/user/project',
    status: 'idle',
    startedAt: Date.now() - 60_000,
    lastActivity: Date.now(),
    eventCount: 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
  } as Conversation
}

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
  useConversationsStore.setState({
    conversationsById: { conv_a: conv('conv_a'), conv_b: conv('conv_b') },
    selectedConversationId: null,
    selectedProjectUri: null,
  })
})

const OPTS = { id: 'debug-control', kind: 'debug-control', title: 'Debug: control' }

describe('modal manager', () => {
  it('opens an instance with its owner scope captured', () => {
    useModalManagerStore.getState().open(OPTS, { type: 'conversation', id: 'conv_a' })
    const rec = useModalManagerStore.getState().records['debug-control']
    expect(rec?.presentation).toBe('inline')
    expect(rec?.scope).toEqual({ type: 'conversation', id: 'conv_a' })
  })

  it('minimizes a parkable modal into the dock', () => {
    const s = useModalManagerStore.getState()
    s.open(OPTS, { type: 'conversation', id: 'conv_a' })
    s.minimize('debug-control')
    expect(useModalManagerStore.getState().records['debug-control']?.presentation).toBe('docked')
  })

  it('refuses to minimize a blocking modal', () => {
    const s = useModalManagerStore.getState()
    s.open({ ...OPTS, id: 'rename', minimizable: false }, { type: 'conversation', id: 'conv_a' })
    s.minimize('rename')
    expect(useModalManagerStore.getState().records.rename?.presentation).toBe('inline')
  })

  it('restore WARPS to the owning conversation, then re-opens', () => {
    const s = useModalManagerStore.getState()
    s.open(OPTS, { type: 'conversation', id: 'conv_a' })
    s.minimize('debug-control')
    // Navigate away to a different conversation.
    useConversationsStore.getState().selectConversation('conv_b', 'test')
    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_b')

    s.restore('debug-control')
    // Warped back to the owner...
    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_a')
    // ...and re-opened.
    expect(useModalManagerStore.getState().records['debug-control']?.presentation).toBe('inline')
  })

  it('close drops the instance entirely', () => {
    const s = useModalManagerStore.getState()
    s.open(OPTS, { type: 'global' })
    s.close('debug-control')
    expect(useModalManagerStore.getState().records['debug-control']).toBeUndefined()
  })

  describe('detach', () => {
    let fakeWin: { focus: () => void; close: () => void; closed: boolean }

    beforeEach(() => {
      fakeWin = { focus: vi.fn(), close: vi.fn(), closed: false }
      vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window)
    })
    afterEach(() => vi.restoreAllMocks())

    it('detaches into its own window and registers the handle', () => {
      const s = useModalManagerStore.getState()
      s.open(OPTS, { type: 'conversation', id: 'conv_a' })
      s.detach('debug-control')
      expect(useModalManagerStore.getState().records['debug-control']?.presentation).toBe('detached')
      expect(getDetachedWindow('debug-control')).toBe(fakeWin)
    })

    it('reattach closes the window and returns inline', () => {
      const s = useModalManagerStore.getState()
      s.open(OPTS, { type: 'conversation', id: 'conv_a' })
      s.detach('debug-control')
      s.reattach('debug-control')
      expect(useModalManagerStore.getState().records['debug-control']?.presentation).toBe('inline')
      expect(fakeWin.close).toHaveBeenCalled()
      expect(getDetachedWindow('debug-control')).toBeUndefined()
    })

    it('parkFromDetached (popup closed by chrome) parks to the dock, keeping the record', () => {
      const s = useModalManagerStore.getState()
      s.open(OPTS, { type: 'conversation', id: 'conv_a' })
      s.detach('debug-control')
      s.parkFromDetached('debug-control')
      expect(useModalManagerStore.getState().records['debug-control']?.presentation).toBe('docked')
      expect(getDetachedWindow('debug-control')).toBeUndefined()
    })

    /**
     * "when I do clear/reload on main window, they stay open - which is
     * impossible". It is: the popup's React tree, store and socket all live in
     * the opener, so a reload leaves pixels with no program behind them and the
     * fresh tab holds no handle to close them with.
     */
    it('closes every popup when the opener goes away', () => {
      const s = useModalManagerStore.getState()
      s.open(OPTS, { type: 'global' })
      s.detach('debug-control')

      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))

      expect(fakeWin.close).toHaveBeenCalled()
      expect(getDetachedWindow('debug-control')).toBeUndefined()
    })

    /** A bfcache freeze is not a death -- the tab can come back with its heap
     *  intact and the popups still wired to it. */
    it('leaves them alone when the page is only frozen into the bfcache', () => {
      const s = useModalManagerStore.getState()
      s.open(OPTS, { type: 'global' })
      s.detach('debug-control')

      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))

      expect(fakeWin.close).not.toHaveBeenCalled()
      expect(getDetachedWindow('debug-control')).toBe(fakeWin)
    })

    it('refuses to detach a blocking modal', () => {
      const s = useModalManagerStore.getState()
      s.open({ ...OPTS, id: 'rename', minimizable: false }, { type: 'conversation', id: 'conv_a' })
      s.detach('rename')
      expect(useModalManagerStore.getState().records.rename?.presentation).toBe('inline')
    })
  })
})
