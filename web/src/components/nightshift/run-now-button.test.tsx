/**
 * RunNowButton: disabled when the queue is empty, confirms before firing (it
 * spawns real agents), triggers the run on confirm, and surfaces a failed
 * trigger's reason inline.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const runNightshiftNow = vi.fn()

vi.mock('@/hooks/use-nightshift-queue', () => ({
  runNightshiftNow: (...args: unknown[]) => runNightshiftNow(...args),
}))

import { RunNowButton } from './run-now-button'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const URI = 'claude://default/p'

describe('RunNowButton', () => {
  test('is disabled and inert when the queue is empty', () => {
    render(<RunNowButton projectUri={URI} disabled />)
    const btn = screen.getByRole('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(runNightshiftNow).not.toHaveBeenCalled()
  })

  test('confirms then triggers the run when clicked', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    runNightshiftNow.mockResolvedValue({ ok: true })
    render(<RunNowButton projectUri={URI} disabled={false} />)
    fireEvent.click(screen.getByRole('button'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(runNightshiftNow).toHaveBeenCalledWith(URI)
  })

  test('does not trigger when confirm is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    runNightshiftNow.mockResolvedValue({ ok: true })
    render(<RunNowButton projectUri={URI} disabled={false} />)
    fireEvent.click(screen.getByRole('button'))
    expect(runNightshiftNow).not.toHaveBeenCalled()
  })

  test('surfaces a failed trigger reason', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    runNightshiftNow.mockResolvedValue({ ok: false, reason: 'queue is empty' })
    render(<RunNowButton projectUri={URI} disabled={false} />)
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText('queue is empty')).toBeDefined()
  })
})
