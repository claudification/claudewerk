/**
 * THE ONE SHEAF FETCH -- shared by A6 (the rollup) and A4 (the state of the
 * union).
 *
 * `GET /api/sheaf?windowH=N` already returns both halves: the structural build
 * plus, since Phase 6, the SOTU narrative and the git fabric folded in by
 * `enrichSheafWithSotu`. Two panes reading it means ONE request, not two, so the
 * response lives in a module-scope store and both panes subscribe. That is also
 * why A6 and A4 are one card.
 *
 * The store is module-scope for the same reason the filter store is: THE WALL is
 * a managed surface and every move between inline / docked / detached / ambient
 * unmounts the tree. State in a provider would be re-fetched on each transition.
 *
 * ADMIN-GATED, and the SOTU enrichment is filtered by the CALLER'S grants
 * server-side. Nothing here widens that -- a 403 renders as a 403.
 *
 * A window switch does NOT blank the panes: the previous response stays up while
 * the next one loads, and every window label a pane renders comes from
 * `data.windowH` (what arrived), never from the selected tab. So the numbers and
 * their window can never disagree, which is the only failure mode that mattered.
 */

import type { SheafResponse } from '@shared/sheaf-types'
import { useEffect } from 'react'
import { create } from 'zustand'

/** The three windows the card names. Hours; 168 = 7d. */
export const SHEAF_WINDOWS = [6, 24, 168] as const
export type SheafWindow = (typeof SHEAF_WINDOWS)[number]

/**
 * Slow on purpose. The sheaf is a rollup over 6 hours at its narrowest, the
 * route rebuilds the whole fleet per request, and each read also schedules a
 * git-fabric rescan per visible project. A minute is far finer than the coarsest
 * thing on the pane and still cheap; this is a ledger, not the pulse.
 */
export const SHEAF_REFRESH_MS = 60_000

interface WallSheafState {
  windowH: SheafWindow
  /** The last response that ARRIVED. Kept across a reload so nothing blanks. */
  data: SheafResponse | null
  loading: boolean
  error: string | null
  setWindow(windowH: SheafWindow): void
}

export const useWallSheafStore = create<WallSheafState>((set, get) => ({
  windowH: 24,
  data: null,
  loading: false,
  error: null,
  setWindow: windowH => {
    if (get().windowH === windowH) return
    set({ windowH })
  },
}))

/** The window currently in flight or already loaded, so two mounting panes and a
 *  refresh tick collapse into one request. */
let inflight: number | null = null

export async function loadWallSheaf(windowH: number, force = false): Promise<void> {
  if (inflight === windowH && !force) return
  inflight = windowH
  useWallSheafStore.setState({ loading: true })
  try {
    const res = await fetch(`/api/sheaf?windowH=${windowH}`)
    if (!res.ok) throw new Error(`sheaf ${res.status}`)
    const data = (await res.json()) as SheafResponse
    // A stale response for a window the user has since left must not overwrite
    // the current one.
    if (useWallSheafStore.getState().windowH !== windowH) return
    useWallSheafStore.setState({ data, loading: false, error: null })
  } catch (err) {
    if (useWallSheafStore.getState().windowH !== windowH) return
    useWallSheafStore.setState({ loading: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (inflight === windowH) inflight = null
  }
}

/** Test seam: forget the in-flight window between cases. */
export function resetWallSheaf(): void {
  inflight = null
  useWallSheafStore.setState({ windowH: 24, data: null, loading: false, error: null })
}

let subscribers = 0
let timer: ReturnType<typeof setInterval> | null = null

/**
 * Subscribe a pane to the feed. The FIRST pane to mount starts the refresh
 * interval and the LAST one to unmount stops it, so a closed wall polls nothing.
 */
export function useWallSheafFeed(): void {
  const windowH = useWallSheafStore(s => s.windowH)

  useEffect(() => {
    void loadWallSheaf(windowH)
  }, [windowH])

  useEffect(() => {
    subscribers++
    if (subscribers === 1 && !timer) {
      timer = setInterval(() => {
        void loadWallSheaf(useWallSheafStore.getState().windowH, true)
      }, SHEAF_REFRESH_MS)
    }
    return () => {
      subscribers--
      if (subscribers === 0 && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }, [])
}
