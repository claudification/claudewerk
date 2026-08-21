/**
 * DELETE -- the second control the dimmed tail is allowed to have.
 *
 * The same three properties `clear`'s test pins (a stray click does nothing, a
 * refusal is VISIBLE, the pane only re-reads after something happened), plus the
 * one that is specific to this verb: the armed label has to say that the CARDS
 * survive, because a button called "delete" sitting on a run row is exactly
 * where a human will assume otherwise.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ del: vi.fn(async () => ({ ok: true as const, data: 'deleted' })) }))
vi.mock('@/lib/epic-inspect-api', () => ({ deleteEpicRun: api.del }))

import { ARM_TIMEOUT_MS } from './run-actions'
import { RunDeleteButton } from './run-delete-button'

beforeEach(() => {
  api.del.mockClear()
  api.del.mockResolvedValue({ ok: true, data: 'deleted' })
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

function mount(onDone = () => {}) {
  render(<RunDeleteButton project="claude:///p" epicId="epic-the-wall" onDone={onDone} />)
  return screen.getByRole('button')
}

describe('the delete button', () => {
  it('does NOTHING on the first click -- it arms', () => {
    const button = mount()

    fireEvent.click(button)

    expect(api.del).not.toHaveBeenCalled()
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  /** THE ONE FACT A HUMAN WILL OTHERWISE GET WRONG. Cards outlive runs by
   *  design, and the confirm is the last moment anybody can be told. */
  it('says the cards survive, in the confirm itself', () => {
    const button = mount()

    fireEvent.click(button)

    expect(button.textContent).toContain('keep cards')
    expect(button.textContent).toContain('sure?')
  })

  it('deletes on the second click and tells the pane to re-read', async () => {
    const onDone = vi.fn()
    const button = mount(onDone)

    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(api.del).toHaveBeenCalledWith('claude:///p', 'epic-the-wall', expect.any(String)))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('disarms on its own, so a half-pressed button cannot be finished an hour later', () => {
    const button = mount()

    fireEvent.click(button)
    act(() => void vi.advanceTimersByTime(ARM_TIMEOUT_MS + 100))

    expect(button.textContent).toBe('delete')
    fireEvent.click(button)
    expect(api.del).not.toHaveBeenCalled()
  })

  /** BOTH REFUSALS ARE THE INTERESTING ANSWER: the run is still live, or one of
   *  its seats is. A button that swallowed either would leave the row sitting
   *  there looking broken. */
  it('shows the refusal instead of swallowing it, and does not re-read', async () => {
    api.del.mockResolvedValue({
      ok: false,
      error: '1 conversation(s) tagged with epic-the-wall are still live',
    } as never)
    const onDone = vi.fn()
    const button = mount(onDone)

    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByText(/still live/)).toBeTruthy())
    expect(onDone).not.toHaveBeenCalled()
  })

  /** It sits directly beside CLEAR and does something CLEAR does not, so it must
   *  not render as the same control one button over. */
  it('is visually distinct from clear, armed and at rest', () => {
    const button = mount()
    expect(button.className).toContain('wall-run-act-danger')

    fireEvent.click(button)

    expect(button.className).toContain('wall-run-act-danger-armed')
  })
})
