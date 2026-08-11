/**
 * Save-and-report behaviour.
 *
 * The server's validation message is the useful one ("cron: minute out of
 * range" beats "invalid"), so the thing worth pinning is that it survives all
 * the way to the editor instead of being swallowed or replaced.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSaveSchedule } from './use-save-schedule'

describe('useSaveSchedule', () => {
  it('calls onSaved when the server accepts', async () => {
    const onSaved = vi.fn()
    const { result } = renderHook(() => useSaveSchedule({ submit: async () => ({ ok: true }), onSaved }))

    await act(async () => {
      await result.current.save()
    })

    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
  })

  it("surfaces the server's message verbatim and does NOT close the editor", async () => {
    const onSaved = vi.fn()
    const { result } = renderHook(() =>
      useSaveSchedule({ submit: async () => ({ ok: false, error: 'cron: minute out of range' }), onSaved }),
    )

    await act(async () => {
      await result.current.save()
    })

    expect(result.current.error).toBe('cron: minute out of range')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('falls back to a readable message when the server sends none', async () => {
    const { result } = renderHook(() => useSaveSchedule({ submit: async () => ({ ok: false }), onSaved: () => {} }))
    await act(async () => {
      await result.current.save()
    })
    expect(result.current.error).toBe('Could not save')
  })

  it('a thrown request becomes an error, not an unhandled rejection', async () => {
    const { result } = renderHook(() =>
      useSaveSchedule({
        submit: async () => {
          throw new Error('network down')
        },
        onSaved: () => {},
      }),
    )

    await act(async () => {
      await result.current.save()
    })

    expect(result.current.error).toBe('network down')
  })

  it('clears saving once settled, so the button never sticks', async () => {
    const { result } = renderHook(() =>
      useSaveSchedule({ submit: async () => ({ ok: false, error: 'nope' }), onSaved: () => {} }),
    )
    await act(async () => {
      await result.current.save()
    })
    await waitFor(() => expect(result.current.saving).toBe(false))
  })

  it('a retry clears the previous error before running', async () => {
    let attempt = 0
    const { result } = renderHook(() =>
      useSaveSchedule({
        submit: async () => {
          attempt++
          return attempt === 1 ? { ok: false, error: 'first failed' } : { ok: true }
        },
        onSaved: () => {},
      }),
    )

    await act(async () => {
      await result.current.save()
    })
    expect(result.current.error).toBe('first failed')

    await act(async () => {
      await result.current.save()
    })
    expect(result.current.error).toBeNull()
  })
})
