/**
 * Data plumbing for the vacuum panel: the estimate, the byte pass, the run, and
 * the live step stream.
 *
 * The estimate is deliberately NOT auto-refreshed on a timer. It is the input
 * to a destructive decision, so it changes only when the user asks -- a number
 * that silently moved between reading it and confirming is the failure mode
 * this whole feature is trying to avoid.
 */

import type { VacuumStepMessage } from '@shared/protocol'
import { useCallback, useEffect, useState } from 'react'
import type { VacuumEstimate, VacuumSelection } from './vacuum-types'

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    throw new Error(res.status === 403 ? 'Admin access required' : `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export interface EstimateState {
  data: VacuumEstimate | null
  error: string | null
  loading: boolean
  /** True while the ~2 minute byte pass is running. */
  measuringBytes: boolean
  refresh: (hotDays: number) => void
  measureBytes: (hotDays: number) => void
}

export function useVacuumEstimate(hotDays: number, armed: boolean): EstimateState {
  const [data, setData] = useState<VacuumEstimate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [measuringBytes, setMeasuringBytes] = useState(false)

  const load = useCallback((days: number, bytes: boolean) => {
    if (bytes) setMeasuringBytes(true)
    else setLoading(true)
    setError(null)
    getJson<VacuumEstimate>(`/api/vacuum/estimate?hotDays=${days}${bytes ? '&bytes=1' : ''}`)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setLoading(false)
        setMeasuringBytes(false)
      })
  }, [])

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    if (armed) load(hotDays, false)
    // Only on arming and on an explicit hotDays change -- see the note above
    // about never refreshing underneath the user.
  }, [armed, hotDays, load])

  return {
    data,
    error,
    loading,
    measuringBytes,
    refresh: days => load(days, false),
    measureBytes: days => load(days, true),
  }
}

function body(selection: VacuumSelection): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(selection),
  }
}

export async function runVacuumPlan(selection: VacuumSelection): Promise<unknown> {
  return getJson('/api/vacuum/plan', body(selection))
}

export async function runVacuumApply(selection: VacuumSelection): Promise<unknown> {
  return getJson('/api/vacuum/apply', body(selection))
}

/** The live step stream. Steps arrive as `vacuum_step` broadcasts, which the
 *  websocket layer re-emits as a window event so this hook stays transport
 *  agnostic and needs no store of its own. */
export function useVacuumSteps(): { steps: VacuumStepMessage[]; clear: () => void } {
  const [steps, setSteps] = useState<VacuumStepMessage[]>([])

  useEffect(() => {
    const onStep = (e: Event) => {
      const detail = (e as CustomEvent<VacuumStepMessage>).detail
      setSteps(prev => [...prev, detail])
    }
    window.addEventListener('vacuum-step', onStep)
    return () => window.removeEventListener('vacuum-step', onStep)
  }, [])

  return { steps, clear: () => setSteps([]) }
}
