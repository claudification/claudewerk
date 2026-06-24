/**
 * Tests for the live-dialog -> global-dock bridge filter.
 *
 * Pins the four rules: only manual minimizes surface (collapsed && !closedAt),
 * the current conversation is excluded (its inline bar covers it), and an entry
 * must exist.
 */
import { describe, expect, it } from 'vitest'
import type { DialogViewState } from './live-dialog-view'
import type { LiveDialogEntry } from './use-live-dialogs'
import { selectMinimizedLiveDialogs } from './use-minimized-live-dialogs'

function entry(title: string): LiveDialogEntry {
  return { dialogId: `d_${title}`, snapshot: { layout: { title } }, rev: 1 } as unknown as LiveDialogEntry
}

function view(over: Partial<DialogViewState>): DialogViewState {
  return { dialogId: 'd', collapsed: false, restoreOnUpdate: false, ...over } as DialogViewState
}

describe('selectMinimizedLiveDialogs', () => {
  const by = { a: entry('Plan A'), b: entry('Plan B'), c: entry('Closed C') }

  it('surfaces a manually-minimized dialog from another conversation', () => {
    const views = { a: view({ collapsed: true }) }
    expect(selectMinimizedLiveDialogs(by, views, 'other')).toEqual([{ conversationId: 'a', title: 'Plan A' }])
  })

  it('excludes the current conversation (its inline bar covers it)', () => {
    const views = { a: view({ collapsed: true }) }
    expect(selectMinimizedLiveDialogs(by, views, 'a')).toEqual([])
  })

  it('ignores an agent-closed (decay) dialog -- closedAt set', () => {
    const views = { c: view({ collapsed: true, closedAt: 123 }) }
    expect(selectMinimizedLiveDialogs(by, views, 'other')).toEqual([])
  })

  it('ignores an expanded dialog', () => {
    const views = { a: view({ collapsed: false }) }
    expect(selectMinimizedLiveDialogs(by, views, 'other')).toEqual([])
  })

  it('skips a view with no matching entry', () => {
    const views = { ghost: view({ collapsed: true }) }
    expect(selectMinimizedLiveDialogs(by, views, 'other')).toEqual([])
  })
})
