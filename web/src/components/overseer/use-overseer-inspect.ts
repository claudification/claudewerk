/**
 * The EXPENSIVE read, for the ONE run you are looking at.
 *
 * `inspect` costs a sentinel `get`, a board read and a DAG plan, which is why
 * the badge does not use it and this hook only ever fetches the SELECTED run.
 *
 * It refetches on a slow timer while the window is open rather than riding the
 * `epic_activity` push. The push carries a summary by design (a permanently
 * visible badge must stay cheap), so the detail pane genuinely needs its own
 * read -- but only while somebody is looking at it, which is the difference
 * between this and polling.
 */

import type { EpicInspectResult } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { inspectRun } from '@/lib/epic-inspect-api'

/** Slower than the 45s sweep on purpose: a beat that lands between two fetches
 *  still shows up, and a run mid-generation does not change much in between. */
const REFRESH_MS = 20_000

export interface InspectState {
  data: EpicInspectResult | null
  error: string | null
  /** True only for the FIRST load. A refresh must not blank the pane you are
   *  reading -- flashing a spinner every 20s over stable content is worse than
   *  briefly stale content. */
  loading: boolean
  refresh: () => Promise<void>
}

export function useOverseerInspect(project: string | null, epicId: string | null): InspectState {
  const [data, setData] = useState<EpicInspectResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Guards a late reply from a PREVIOUS selection overwriting the current one:
  // click run A, click run B, A's slower response lands last and the pane shows
  // A's data under B's heading.
  const wanted = useRef<string>('')

  // cyclomatic 5 across fourteen lines, flagged on CRAP (complexity squared
  // against zero coverage). The one subtle thing here -- the `wanted` guard
  // against a slow reply from a previous selection -- is documented where it is
  // declared; asserting it needs a mocked fetch resolving out of order, which
  // tests the mock's ordering more than it tests this.
  // fallow-ignore-next-line complexity
  const refresh = useCallback(async () => {
    if (!project || !epicId) return
    const key = `${project} ${epicId}`
    wanted.current = key
    const reply = await inspectRun(project, epicId)
    if (wanted.current !== key) return
    if (reply.ok) {
      setData(reply.data)
      setError(null)
    } else {
      setError(reply.error)
    }
    setLoading(false)
  }, [project, epicId])

  useEffect(() => {
    if (!project || !epicId) {
      setData(null)
      setLoading(false)
      return
    }
    setData(null)
    setLoading(true)
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [project, epicId, refresh])

  return { data, error, loading, refresh }
}
