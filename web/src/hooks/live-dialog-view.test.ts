import type { DialogOp, DialogSnapshot, DialogStatus } from '@shared/dialog-live'
import { describe, expect, it } from 'vitest'
import { foldPrefs, freshView, transitionView } from './live-dialog-view'

function snap(status: DialogStatus, extra?: Partial<DialogSnapshot>): DialogSnapshot {
  return {
    dialogId: 'd1',
    layout: { title: 'T', body: [{ type: 'TextInput', id: 'note', label: 'Note' }] },
    state: {},
    seq: 1,
    status,
    ...extra,
  }
}

describe('transitionView', () => {
  it('auto-collapses + stamps closedAt when the agent drives it terminal', () => {
    const prev = freshView(snap('open'))
    const next = transitionView(prev, snap('closed'), 'open', [], 1000)
    expect(next.collapsed).toBe(true)
    expect(next.closedAt).toBe(1000)
  })

  it('un-collapses + clears the decay clock on reopen', () => {
    const closed = transitionView(freshView(snap('open')), snap('closed'), 'open', [], 1000)
    const reopened = transitionView(closed, snap('open'), 'closed', [], 2000)
    expect(reopened.collapsed).toBe(false)
    expect(reopened.closedAt).toBeUndefined()
  })

  it('keeps a manual minimize across an open->open patch (does not auto-expand)', () => {
    const minimized = { ...freshView(snap('open')), collapsed: true }
    const next = transitionView(minimized, snap('open'), 'open', [], 3000)
    expect(next.collapsed).toBe(true)
    expect(next.closedAt).toBeUndefined()
  })

  it('preserves user input and applies an explicit setState op', () => {
    const prev = { ...freshView(snap('open')), values: { note: 'typed' } }
    const ops: DialogOp[] = [{ op: 'setState', key: 'other', value: 7 }]
    const next = transitionView(prev, snap('open'), 'open', ops, 0)
    expect(next.values.note).toBe('typed')
    expect(next.values.other).toBe(7)
  })

  it('resolves the wait bar on any apply', () => {
    const prev = { ...freshView(snap('open')), pending: true, submitRev: 5 }
    const next = transitionView(prev, snap('open'), 'open', [], 0)
    expect(next.pending).toBe(false)
  })
})

describe('foldPrefs', () => {
  it('restores a persisted minimize for the same dialog', () => {
    const view = freshView(snap('open'))
    const next = foldPrefs(view, { dialogId: 'd1', collapsed: true, dismissed: false })
    expect(next.collapsed).toBe(true)
    expect(next.dismissed).toBe(false)
  })

  it('restores a persisted dismiss for the same dialog', () => {
    const next = foldPrefs(freshView(snap('open')), { dialogId: 'd1', collapsed: false, dismissed: true })
    expect(next.dismissed).toBe(true)
  })

  it('ignores a pref for a different (stale) dialogId', () => {
    const next = foldPrefs(freshView(snap('open')), { dialogId: 'OTHER', collapsed: true, dismissed: true })
    expect(next.collapsed).toBe(false)
    expect(next.dismissed).toBe(false)
  })

  it('keeps an agent-close collapse even when the pref says not collapsed', () => {
    const closed = transitionView(freshView(snap('open')), snap('closed'), 'open', [], 1000)
    const next = foldPrefs(closed, { dialogId: 'd1', collapsed: false, dismissed: false })
    expect(next.collapsed).toBe(true)
  })

  it('keeps the decay clock continuous via the persisted closedAt', () => {
    const view = { ...freshView(snap('open')), collapsed: true }
    const next = foldPrefs(view, { dialogId: 'd1', collapsed: true, dismissed: false, closedAt: 1234 })
    expect(next.closedAt).toBe(1234)
  })

  it('is a no-op without a pref', () => {
    const view = freshView(snap('open'))
    expect(foldPrefs(view, undefined)).toBe(view)
  })
})
