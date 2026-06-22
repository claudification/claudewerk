import type { DialogLayout } from '@shared/dialog-schema'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useLiveDialogsStore } from '@/hooks/use-live-dialogs'
import { PersistentDialog } from './persistent-dialog'
import { setupDialogConversation } from './persistent-dialog-test-utils'

const sent: Array<Record<string, unknown>> = []

function snapshot(layout: DialogLayout) {
  return { dialogId: 'd1', layout, state: {}, seq: 1, status: 'open' as const }
}

beforeEach(() => {
  sent.length = 0
  setupDialogConversation(sent)
  useLiveDialogsStore.setState({ byConversation: {}, viewByConversation: {} })
})
afterEach(cleanup)

describe('PersistentDialog — finalize + persistence', () => {
  it('decodes HTML entities in the title (&quot; -> ")', () => {
    const layout: DialogLayout = { title: 'Plan (&quot;Overwatch&quot;)', persistent: true, body: [] }
    useLiveDialogsStore.getState().show('c1', snapshot(layout))
    render(<PersistentDialog conversationId="c1" entry={useLiveDialogsStore.getState().byConversation.c1} />)
    expect(screen.getByText('Plan ("Overwatch")')).toBeTruthy()
  })

  it('finalize submits with _final AND closes in one gesture', async () => {
    const layout: DialogLayout = {
      title: 'Plan',
      persistent: true,
      finalizeLabel: 'Approve all',
      body: [{ type: 'TextInput', id: 'note', label: 'Note' }],
    }
    useLiveDialogsStore.getState().show('c1', snapshot(layout))
    render(<PersistentDialog conversationId="c1" entry={useLiveDialogsStore.getState().byConversation.c1} />)
    fireEvent.click(screen.getByRole('button', { name: /approve all/i }))
    // send() is async (awaits any draw-blob spill) -> emits land a microtask later.
    await waitFor(() => expect(sent.filter(m => m.handlerId === '__submit__')).toHaveLength(1))
    const submits = sent.filter(m => m.handlerId === '__submit__')
    const closes = sent.filter(m => m.handlerId === '__close__')
    expect((submits[0] as { state: Record<string, unknown> }).state._final).toBe(true)
    expect(closes).toHaveLength(1)
  })

  it('SHIFT+click on Send minimizes + arms auto-restore, and still submits', async () => {
    const layout: DialogLayout = {
      title: 'Plan',
      persistent: true,
      body: [{ type: 'TextInput', id: 'note', label: 'Note' }],
    }
    useLiveDialogsStore.getState().show('c1', snapshot(layout))
    render(<PersistentDialog conversationId="c1" entry={useLiveDialogsStore.getState().byConversation.c1} />)
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }), { shiftKey: true })
    // Minimize + arm happen synchronously on click, before the async emit.
    const view = useLiveDialogsStore.getState().viewByConversation.c1
    expect(view.collapsed).toBe(true)
    expect(view.restoreOnUpdate).toBe(true)
    await waitFor(() => expect(sent.filter(m => m.handlerId === '__submit__')).toHaveLength(1))
  })

  it('plain (no-shift) click on Send does NOT minimize', () => {
    const layout: DialogLayout = {
      title: 'Plan',
      persistent: true,
      body: [{ type: 'TextInput', id: 'note', label: 'Note' }],
    }
    useLiveDialogsStore.getState().show('c1', snapshot(layout))
    render(<PersistentDialog conversationId="c1" entry={useLiveDialogsStore.getState().byConversation.c1} />)
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    const view = useLiveDialogsStore.getState().viewByConversation.c1
    expect(view.collapsed).toBe(false)
    expect(view.restoreOnUpdate).toBe(false)
  })

  it('keeps a half-filled form across an unmount/remount (conversation switch)', () => {
    const layout: DialogLayout = {
      title: 'Plan',
      persistent: true,
      body: [{ type: 'TextInput', id: 'note', label: 'Note' }],
    }
    useLiveDialogsStore.getState().show('c1', snapshot(layout))
    const { unmount } = render(
      <PersistentDialog conversationId="c1" entry={useLiveDialogsStore.getState().byConversation.c1} />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft answer' } })
    unmount() // simulate switching away to another conversation
    render(<PersistentDialog conversationId="c1" entry={useLiveDialogsStore.getState().byConversation.c1} />)
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('draft answer')
  })
})
