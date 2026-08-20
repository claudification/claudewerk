/**
 * CLEAR -- the one control the dimmed tail is allowed to have.
 *
 * Three properties, and all three are about a surface that is glanced at from
 * across a room: a stray click must do nothing, a REFUSAL must be visible (the
 * sentinel refuses a live run, and a button that swallowed that would leave the
 * row there with no reason -- the silence this section exists to end), and the
 * pane must only re-read after a clear that actually happened.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ clear: vi.fn(async () => ({ ok: true, run: null, baton: [] })) }))
vi.mock('@/lib/epic-run-api', () => ({ clearEpicRun: api.clear }))

import { ARM_TIMEOUT_MS } from './run-actions'
import { RunClearButton } from './run-clear-button'

beforeEach(() => {
  api.clear.mockClear()
  api.clear.mockResolvedValue({ ok: true, run: null, baton: [] })
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

function mount(onDone = () => {}) {
  render(<RunClearButton project="claude:///p" epicId="epic-the-wall" onDone={onDone} />)
  return screen.getByRole('button')
}

describe('the clear button', () => {
  it('does NOTHING on the first click -- it arms', () => {
    const button = mount()

    fireEvent.click(button)

    expect(api.clear).not.toHaveBeenCalled()
    expect(button.textContent).toContain('sure?')
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('clears on the second click and tells the pane to re-read', async () => {
    const onDone = vi.fn()
    const button = mount(onDone)

    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(api.clear).toHaveBeenCalledWith('claude:///p', 'epic-the-wall'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('disarms on its own, so a half-pressed button cannot be finished an hour later', () => {
    const button = mount()

    fireEvent.click(button)
    act(() => void vi.advanceTimersByTime(ARM_TIMEOUT_MS + 100))

    expect(button.textContent).toBe('clear')
    fireEvent.click(button)
    expect(api.clear).not.toHaveBeenCalled()
  })

  /** THE REFUSAL IS THE INTERESTING ANSWER. The sentinel refuses a live run; if
   *  that came back silent, the row would just sit there and the button would
   *  look broken. */
  it('shows the sentinel refusal instead of swallowing it, and does not re-read', async () => {
    api.clear.mockResolvedValue({ ok: false, error: 'run is armed -- pause or abort it before clearing' } as never)
    const onDone = vi.fn()
    const button = mount(onDone)

    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByText(/pause or abort it/)).toBeTruthy())
    expect(onDone).not.toHaveBeenCalled()
  })
})
