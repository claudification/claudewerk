/**
 * Sheaf data hook -- fetches `GET /api/sheaf` for the selected window.
 *
 * `active` gates the fetch: the Sheaf modal stays mounted at the app shell
 * (managed-surface pattern), so we only load while the surface is open. Flipping
 * active back on refetches, so a reopened Sheaf is always fresh.
 */

import type { SheafResponse } from '@shared/sheaf-types'
import { useCallback, useEffect, useState } from 'react'

interface SheafState {
  data: SheafResponse | null
  loading: boolean
  error: string | null
}

async function fetchSheaf(windowH: number): Promise<SheafResponse> {
  const res = await fetch(`/api/sheaf?windowH=${windowH}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`sheaf fetch failed: ${res.status} ${body.slice(0, 200)}`)
  }
  return (await res.json()) as SheafResponse
}

export function useSheaf(windowH: number, active: boolean): SheafState & { reload: () => void } {
  const [state, setState] = useState<SheafState>({ data: null, loading: true, error: null })
  const [tick, setTick] = useState(0)

  // Reset loading state synchronously on windowH/tick change (render-time adjustment)
  const [prevKey, setPrevKey] = useState({ windowH, tick })
  if (windowH !== prevKey.windowH || tick !== prevKey.tick) {
    setPrevKey({ windowH, tick })
    setState(s => ({ ...s, loading: true, error: null }))
  }

  useEffect(() => {
    if (!active) return
    let cancelled = false
    fetchSheaf(windowH)
      .then(data => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ data: null, loading: false, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [windowH, tick, active])

  const reload = useCallback(() => setTick(t => t + 1), [])
  return { ...state, reload }
}
