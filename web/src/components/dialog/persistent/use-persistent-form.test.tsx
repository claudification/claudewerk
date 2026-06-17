import type { DialogOp } from '@shared/dialog-live'
import type { DialogLayout } from '@shared/dialog-schema'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LiveDialogEntry } from '@/hooks/use-live-dialogs'
import { usePersistentDialogForm } from './use-persistent-form'

function entry(layout: DialogLayout, opts: Partial<LiveDialogEntry> & { rev: number }): LiveDialogEntry {
  return {
    conversationId: 'c1',
    dialogId: 'd1',
    snapshot: { dialogId: 'd1', layout, state: {}, seq: opts.rev, status: 'open' },
    lastOps: [],
    replay: false,
    ...opts,
  }
}

const base: DialogLayout = { title: 'T', body: [{ type: 'TextInput', id: 'name', label: 'Name' }] }

function renderForm(initial: LiveDialogEntry) {
  return renderHook(({ e }) => usePersistentDialogForm(e), { initialProps: { e: initial } })
}

describe('usePersistentDialogForm', () => {
  it('keeps user input across a structural patch (input-not-clobbered)', () => {
    const { result, rerender } = renderForm(entry(base, { rev: 1 }))
    act(() => result.current.form.setValue('name', 'ada'))
    expect(result.current.values.name).toBe('ada')

    const layout2: DialogLayout = { title: 'T', body: [{ type: 'TextInput', id: 'name', label: 'Your name' }] }
    const ops: DialogOp[] = [
      { op: 'replace', id: 'name', block: { type: 'TextInput', id: 'name', label: 'Your name' } },
    ]
    rerender({ e: entry(layout2, { rev: 2, lastOps: ops }) })

    expect(result.current.values.name).toBe('ada') // preserved
    expect(result.current.canUndo).toBe(true)
    expect(result.current.highlightIds.has('name')).toBe(true)
  })

  it('applies an explicit setState op (agent override)', () => {
    const { result, rerender } = renderForm(entry(base, { rev: 1 }))
    act(() => result.current.form.setValue('name', 'ada'))
    const ops: DialogOp[] = [{ op: 'setState', key: 'name', value: 'grace' }]
    rerender({ e: entry(base, { rev: 2, lastOps: ops }) })
    expect(result.current.values.name).toBe('grace')
  })

  it('seeds defaults for newly-appended blocks', () => {
    const { result, rerender } = renderForm(entry(base, { rev: 1 }))
    const layout2: DialogLayout = {
      title: 'T',
      body: [
        { type: 'TextInput', id: 'name', label: 'Name' },
        { type: 'Toggle', id: 'ship', label: 'Ship it', default: true },
      ],
    }
    const ops: DialogOp[] = [{ op: 'append', block: { type: 'Toggle', id: 'ship', label: 'Ship it', default: true } }]
    rerender({ e: entry(layout2, { rev: 2, lastOps: ops }) })
    expect(result.current.values.ship).toBe(true)
  })

  it('undo restores the prior layout view', () => {
    const { result, rerender } = renderForm(entry(base, { rev: 1 }))
    const layout2: DialogLayout = { title: 'T', body: [{ type: 'TextInput', id: 'name', label: 'CHANGED' }] }
    rerender({
      e: entry(layout2, { rev: 2, lastOps: [{ op: 'replace', id: 'name', block: layout2.body![0] }] }),
    })
    expect(result.current.layout.body?.[0]).toMatchObject({ label: 'CHANGED' })
    act(() => result.current.undo())
    expect(result.current.layout.body?.[0]).toMatchObject({ label: 'Name' })
    expect(result.current.canUndo).toBe(false)
  })

  it('does not ring undo / highlight on a reconnect replay', () => {
    const { result, rerender } = renderForm(entry(base, { rev: 1 }))
    rerender({ e: entry(base, { rev: 2, replay: true }) })
    expect(result.current.canUndo).toBe(false)
    expect(result.current.highlightIds.size).toBe(0)
  })
})
