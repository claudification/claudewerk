import type { DialogOp, DialogSnapshot, DialogStatus } from '@shared/dialog-live'
import { describe, expect, it } from 'vitest'
import { freshView, transitionView } from './live-dialog-view'

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
