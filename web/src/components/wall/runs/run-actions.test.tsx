/**
 * THE CONFIRM GATE. The card's rule is "nothing fires on hover or on a stray
 * click", and a gate that is only asserted by reading the source is not a gate.
 *
 * The verbs themselves are stubbed: what is under test is whether they are
 * reached, never what they do -- they belong to the overseer window and have
 * their own coverage there.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verbs = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../overseer/overseer-verbs', () => ({
  VERBS: {
    beat: async () => {
      verbs.calls.push('beat')
      return 'beat done'
    },
    pause: async () => {
      verbs.calls.push('pause')
      return 'paused'
    },
    resume: async () => {
      verbs.calls.push('resume')
      return 'resumed'
    },
  },
}))

import { ARM_TIMEOUT_MS, RunActions } from './run-actions'

const props = { project: 'claude:///p', epicId: 'epic-the-wall', run: null, onDone: () => {} }

beforeEach(() => {
  verbs.calls = []
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('the run action gate', () => {
  it('does NOT fire on the first click -- it arms and says so', () => {
    render(<RunActions {...props} live />)

    fireEvent.click(screen.getByText('beat now'))

    expect(verbs.calls).toEqual([])
    expect(screen.getByText('beat -- sure?')).toBeTruthy()
    expect(screen.getByText('beat -- sure?').getAttribute('aria-pressed')).toBe('true')
  })

  it('fires on the SECOND click, and disarms itself', async () => {
    render(<RunActions {...props} live />)

    fireEvent.click(screen.getByText('beat now'))
    await act(async () => {
      fireEvent.click(screen.getByText('beat -- sure?'))
    })

    expect(verbs.calls).toEqual(['beat'])
    expect(screen.getByText('beat now')).toBeTruthy()
    expect(screen.getByText('beat done')).toBeTruthy()
  })

  it('DISARMS on a timer, so a half-pressed button cannot be finished an hour later', () => {
    render(<RunActions {...props} live />)

    fireEvent.click(screen.getByText('beat now'))
    act(() => {
      vi.advanceTimersByTime(ARM_TIMEOUT_MS + 10)
    })

    expect(screen.getByText('beat now')).toBeTruthy()
    expect(verbs.calls).toEqual([])
  })

  it('arming one verb disarms the other -- a stray click cannot complete a confirm', () => {
    render(<RunActions {...props} live />)

    fireEvent.click(screen.getByText('beat now'))
    fireEvent.click(screen.getByText('pause'))

    expect(screen.getByText('beat now')).toBeTruthy()
    expect(screen.getByText('pause -- sure?')).toBeTruthy()
    expect(verbs.calls).toEqual([])
  })

  it('offers RESUME instead of PAUSE once the run is not live', () => {
    render(<RunActions {...props} live={false} />)

    expect(screen.queryByText('pause')).toBeNull()
    expect(screen.getByText('resume')).toBeTruthy()
  })

  it('does NOT offer ABORT -- a terminal action is not a glanceable one', () => {
    render(<RunActions {...props} live />)
    expect(screen.queryByText(/abort/i)).toBeNull()
  })
})
