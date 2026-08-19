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
 *
 * "SOMEBODY IS LOOKING AT IT" IS NOT THE SAME AS "THE MODAL IS OPEN." A bare
 * interval got both halves of that wrong at once: it kept paying for an inspect
 * every 20s against a hidden tab that nobody could see, and then -- because
 * browsers throttle and eventually suspend timers in a hidden tab, and a sleeping
 * laptop fires none at all -- it showed HOURS-old numbers for up to a full
 * interval after you came back, with nothing on screen saying so. An unattended
 * run is precisely the thing you leave open and glance at later, so the stale
 * window landed exactly where it hurt.
 *
 * So the timer only runs while the document is visible, and the three moments
 * that mean "you are looking now, and what you last saw may be a lie" each force
 * an immediate read: the tab becoming visible, the socket coming back, and the
 * selection changing.
 */

import type { EpicInspectResult } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { inspectRun } from '@/lib/epic-inspect-api'

/** Slower than the 45s sweep on purpose: a beat that lands between two fetches
 *  still shows up, and a run mid-generation does not change much in between. */
const REFRESH_MS = 20_000

/** Past this, what is on screen is old enough to say so rather than imply it is
 *  current. Two intervals: one missed tick is a slow request, not a stall. */
const STALE_AFTER_MS = REFRESH_MS * 2

/**
 * Should the socket coming back force an immediate read?
 *
 * A reconnect means the panel was cut off from the broker for some UNBOUNDED
 * stretch -- exactly the window in which a run advances generations unseen.
 * Waiting up to a full refresh interval to discover that is the same staleness
 * by another route.
 *
 * `hidden` still vetoes it: a background tab reconnecting is not somebody
 * looking, and the visibility handler will read the moment it becomes one. Pure
 * and exported so the rule is testable without a socket, a store or a DOM.
 */
export function shouldRefetchOnReconnect(s: {
  connected: boolean
  project: string | null
  epicId: string | null
  hidden: boolean
}): boolean {
  return s.connected && !s.hidden && s.project !== null && s.epicId !== null
}

export interface InspectState {
  data: EpicInspectResult | null
  error: string | null
  /** True only for the FIRST load. A refresh must not blank the pane you are
   *  reading -- flashing a spinner every 20s over stable content is worse than
   *  briefly stale content. */
  loading: boolean
  /** When the displayed data was actually fetched. Null before the first read.
   *  The pane renders this rather than letting old numbers pass for live ones. */
  fetchedAt: number | null
  /** Is the displayed data older than two refresh intervals? */
  stale: boolean
  refresh: () => Promise<void>
}

export function useOverseerInspect(project: string | null, epicId: string | null): InspectState {
  const [data, setData] = useState<EpicInspectResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [stale, setStale] = useState(false)

  const isConnected = useConversationsStore(s => s.isConnected)

  // Guards a late reply from a PREVIOUS selection overwriting the current one:
  // click run A, click run B, A's slower response lands last and the pane shows
  // A's data under B's heading.
  const wanted = useRef<string>('')

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
      setFetchedAt(Date.now())
      setStale(false)
    } else {
      setError(reply.error)
    }
    setLoading(false)
  }, [project, epicId])

  useEffect(() => {
    if (!project || !epicId) {
      setData(null)
      setLoading(false)
      setFetchedAt(null)
      return
    }
    setData(null)
    setLoading(true)
    setFetchedAt(null)
    void refresh()

    // The timer exists only while the tab is visible. Restarted rather than left
    // running so the first tick after you return is a full interval away from
    // the fresh read below, not a leftover from before the tab was hidden.
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer === null) timer = setInterval(() => void refresh(), REFRESH_MS)
    }
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }

    const onVisibility = () => {
      if (document.hidden) {
        stop()
        return
      }
      // Read FIRST, then resume the cadence: the whole point is that what is on
      // screen at the moment you look is current, not current 20 seconds later.
      void refresh()
      start()
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [project, epicId, refresh])

  useEffect(() => {
    if (shouldRefetchOnReconnect({ connected: isConnected, project, epicId, hidden: document.hidden })) void refresh()
  }, [isConnected, project, epicId, refresh])

  // Age is a render concern, so it ticks on its own slow clock rather than
  // forcing a re-render of the pane on every second.
  useEffect(() => {
    if (fetchedAt === null) return
    const check = () => setStale(Date.now() - fetchedAt > STALE_AFTER_MS)
    check()
    const timer = setInterval(check, 5_000)
    return () => clearInterval(timer)
  }, [fetchedAt])

  return { data, error, loading, fetchedAt, stale, refresh }
}
