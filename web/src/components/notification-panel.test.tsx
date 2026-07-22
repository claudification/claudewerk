/**
 * Regression tests for the NOTIFY item in the bell's notification list:
 *   1. the message renders MARKDOWN
 *   2. the project name shows in the group header (bound to a conversation)
 *   3. clicking the item navigates (selectConversation + onClose); the X
 *      dismisses and does NOT navigate.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { NotificationPanel } from './notification-panel'

const selectConversation = vi.fn()
const dismissNotification = vi.fn()

const fakeState = {
  conversationsById: { 'conv-1': { project: 'claude://s/CLAUDEWERK', title: 'orb work' } },
  projectSettings: { pk: { label: 'CLAUDEWERK' } },
  selectConversation,
  pendingPermissions: [],
  respondToPermission: vi.fn(),
  sendPermissionRule: vi.fn(),
  pendingProjectLinks: [],
  respondToProjectLink: vi.fn(),
  pendingAskQuestions: [],
  pendingDialogs: {},
  notifications: [
    {
      id: 'n1',
      conversationId: 'conv-1',
      title: 'done',
      message: 'Shipped **green** and `24626172`',
      timestamp: 1_700_000_000_000,
    },
  ],
  dismissNotification,
}

vi.mock('@shared/project-uri', () => ({ projectIdentityKey: () => 'pk' }))
vi.mock('@/lib/types', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/types')>()),
  projectPath: (p: string) => p,
}))
vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: (sel: (s: typeof fakeState) => unknown) => sel(fakeState),
}))

afterEach(() => {
  cleanup()
  selectConversation.mockClear()
  dismissNotification.mockClear()
})

test('renders the notification message as markdown and shows the project name', () => {
  const { container } = render(<NotificationPanel onClose={vi.fn()} />)
  expect(screen.getByText('CLAUDEWERK')).toBeTruthy()
  expect(container.querySelector('strong')?.textContent).toBe('green')
  expect(container.querySelector('code')?.textContent).toBe('24626172')
  expect(container.textContent).not.toContain('**green**')
})

test('clicking the notification message navigates and closes', () => {
  const onClose = vi.fn()
  const { container } = render(<NotificationPanel onClose={onClose} />)
  fireEvent.click(container.querySelector('strong')!)
  expect(selectConversation).toHaveBeenCalledWith('conv-1', 'notification-panel')
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('clicking the X dismisses without navigating', () => {
  render(<NotificationPanel onClose={vi.fn()} />)
  fireEvent.click(screen.getByText('X'))
  expect(dismissNotification).toHaveBeenCalledWith('n1')
  expect(selectConversation).not.toHaveBeenCalled()
})
