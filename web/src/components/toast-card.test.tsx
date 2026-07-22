/**
 * Regression tests for the notification requirements on ToastCard:
 *   1. the body renders MARKDOWN (not raw `**bold**` / `` `code` `` text)
 *   2. the owning project's display NAME shows when the toast is bound to a conversation
 *   3. clicking anywhere EXCEPT the close (X) button fires onClick (navigate);
 *      the X fires onDismiss and does NOT bubble to onClick.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { Toast } from './toast'
import { ToastCard } from './toast-card'

vi.mock('@shared/project-uri', () => ({ projectIdentityKey: () => 'pk' }))

vi.mock('@/lib/types', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/types')>()),
  projectPath: (p: string) => p,
}))

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: Object.assign(() => ({}), {
    getState: () => ({
      conversationsById: { 'conv-1': { project: 'claude://s/CLAUDEWERK' } },
      projectSettings: { pk: { label: 'CLAUDEWERK' } },
    }),
  }),
}))

afterEach(cleanup)

function makeToast(over: Partial<Toast> = {}): Toast {
  return { id: 1, title: 'VOICE-ORB BUILD: DONE', body: 'plain', ...over }
}

test('renders the body as markdown (bold + inline code become elements)', () => {
  const { container } = render(
    <ToastCard
      toast={makeToast({ body: 'Shipped (`24626172`), **Caption bug fixed**' })}
      onClick={vi.fn()}
      onDismiss={vi.fn()}
    />,
  )
  expect(container.querySelector('strong')?.textContent).toBe('Caption bug fixed')
  expect(container.querySelector('code')?.textContent).toBe('24626172')
  // The raw markdown source must NOT survive as literal text.
  expect(container.textContent).not.toContain('**Caption bug fixed**')
})

test('shows the project display name when bound to a conversation', () => {
  render(<ToastCard toast={makeToast({ conversationId: 'conv-1' })} onClick={vi.fn()} onDismiss={vi.fn()} />)
  expect(screen.getByText('CLAUDEWERK')).toBeTruthy()
})

test('omits the project name when the toast is not bound to a conversation', () => {
  render(<ToastCard toast={makeToast()} onClick={vi.fn()} onDismiss={vi.fn()} />)
  expect(screen.queryByText('CLAUDEWERK')).toBeNull()
})

test('clicking the card body fires onClick (navigate)', () => {
  const onClick = vi.fn()
  render(<ToastCard toast={makeToast({ conversationId: 'conv-1' })} onClick={onClick} onDismiss={vi.fn()} />)
  fireEvent.click(screen.getByText('VOICE-ORB BUILD: DONE'))
  expect(onClick).toHaveBeenCalledTimes(1)
})

test('clicking the X fires onDismiss and does NOT bubble to onClick', () => {
  const onClick = vi.fn()
  const onDismiss = vi.fn()
  const { container } = render(
    <ToastCard toast={makeToast({ conversationId: 'conv-1' })} onClick={onClick} onDismiss={onDismiss} />,
  )
  const closeBtn = container.querySelector('button[type="button"]')
  expect(closeBtn).toBeTruthy()
  fireEvent.click(closeBtn!)
  expect(onDismiss).toHaveBeenCalledTimes(1)
  expect(onClick).not.toHaveBeenCalled()
})
