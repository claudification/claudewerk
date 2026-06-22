import type { DialogLayout } from '@shared/dialog-schema'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('finalize submits with _final AND closes in one gesture', () => {
    const layout: DialogLayout = {
      title: 'Plan',
      persistent: true,
      finalizeLabel: 'Approve all',
      body: [{ type: 'TextInput', id: 'note', label: 'Note' }],
    }
    useLiveDialogsStore.getState().show('c1', snapshot(layout))
    render(<PersistentDialog conversationId="c1" entry={useLiveDialogsStore.getState().byConversation.c1} />)
    fireEvent.click(screen.getByRole('button', { name: /approve all/i }))
    const submits = sent.filter(m => m.handlerId === '__submit__')
    const closes = sent.filter(m => m.handlerId === '__close__')
    expect(submits).toHaveLength(1)
    expect((submits[0] as { state: Record<string, unknown> }).state._final).toBe(true)
    expect(closes).toHaveLength(1)
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
