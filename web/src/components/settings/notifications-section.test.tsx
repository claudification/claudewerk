/**
 * Regression test for "unable to un-register from notifications".
 *
 * handlePushToggle used to call subscribeToPush() unconditionally, so once the
 * button read "Enabled" there was no way to turn push off -- clicking it just
 * re-subscribed you. The toggle must branch on the current state.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NotificationsSection } from './notifications-section'

const push = vi.hoisted(() => ({
  getPushStatus: vi.fn(),
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}))

vi.mock('@/lib/push', () => push)

beforeEach(() => {
  push.getPushStatus.mockResolvedValue({ supported: true, subscribed: true, permission: 'granted' })
  push.subscribeToPush.mockResolvedValue({ success: true })
  push.unsubscribeFromPush.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NotificationsSection toggle', () => {
  test('clicking while subscribed unsubscribes instead of re-subscribing', async () => {
    render(<NotificationsSection />)
    const button = await screen.findByRole('button', { name: /Enabled/ })

    button.click()

    await waitFor(() => expect(push.unsubscribeFromPush).toHaveBeenCalledTimes(1))
    expect(push.subscribeToPush).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: /Enable$/ })).toBeTruthy())
  })

  test('clicking while off subscribes', async () => {
    push.getPushStatus.mockResolvedValue({ supported: true, subscribed: false, permission: 'default' })
    render(<NotificationsSection />)
    const button = await screen.findByRole('button', { name: /Enable/ })

    button.click()

    await waitFor(() => expect(push.subscribeToPush).toHaveBeenCalledTimes(1))
    expect(push.unsubscribeFromPush).not.toHaveBeenCalled()
  })

  test('surfaces the error when unsubscribing fails but still shows push as off', async () => {
    push.unsubscribeFromPush.mockResolvedValue({ success: false, error: 'broker unreachable' })
    render(<NotificationsSection />)
    const button = await screen.findByRole('button', { name: /Enabled/ })

    button.click()

    await waitFor(() => expect(screen.getByText('broker unreachable')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Enable$/ })).toBeTruthy()
  })
})
