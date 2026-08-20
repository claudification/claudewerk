/**
 * A9's feed: ONE request, five metrics, `/api/stats/activity-matrix`.
 *
 * THE ZONE IS SENT, NEVER ASSUMED. The broker container runs in UTC and would
 * happily bucket a Thai evening onto the next day's square. `tz` is a required
 * parameter on the route with no fallback, and this is the only caller, so the
 * zone travelling with the request is the whole of that guarantee on this side.
 * It is read from `Intl` rather than from a setting: the grid is a claim about
 * the days the READER lived, and the reader is wherever the browser is.
 *
 * A SHAPE CHECK, NOT A CAST. The wall's own test rigs answer every unrecognised
 * feed with a bare `[]`, and the admin-only route answers a non-admin with a 403
 * body. Both would type-assert into a matrix with no days in it, and a grid of
 * zero days renders as a pane that looks loaded and says nothing. Anything that
 * is not a matrix lands as `null`, which the pane draws as "no feed".
 *
 * A SLOW POLL on purpose. Day buckets move once a day; the only thing that can
 * change within a session is today's square. Fifteen minutes is well inside that
 * and the reconnect pull (`useWallRevive`) covers the case that actually loses
 * data -- a broker restart.
 */

import { ACTIVITY_DEFAULT_DAYS, type ActivityMatrix } from '@shared/activity-matrix'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallRevive } from '@/lib/wall/use-wall-revive'

/** Today's square is the only one that moves inside a session. */
const ACTIVITY_REFRESH_MS = 15 * 60_000

/** The reader's own IANA zone, or UTC if this runtime will not name one. Split
 *  out so the pane can print the zone it asked for beside the grid -- a reader
 *  who cannot see which calendar the squares are in cannot check them. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export interface ActivityFeed {
  /** The matrix, or `null` when nothing legible has ever arrived. */
  matrix: ActivityMatrix | null
  /** True once the request has settled at least once, however it settled. */
  settled: boolean
  /** What is on screen was read on an EARLIER connection than the current one. */
  stale: boolean
}

const EMPTY: ActivityFeed = { matrix: null, settled: false, stale: false }

/** Is this really a matrix? Every field the pane indexes into, checked once. */
function isMatrix(body: unknown): body is ActivityMatrix {
  if (typeof body !== 'object' || body === null) return false
  const m = body as Partial<ActivityMatrix>
  return typeof m.tz === 'string' && Array.isArray(m.days) && Array.isArray(m.metrics)
}

// Fallow reads the twelve lines below as a clone of `use-burn-feed`. They are the
// same IDIOM (mounted ref, fetch, validate, keep-what-we-had) and not the same
// LOGIC -- different URL, different guard, different state shape. Two instances of
// a React idiom is not yet an abstraction; a THIRD feed hook is the moment to
// extract `useJsonFeed<T>(url, isT)` and to fold both of these into it.
// fallow-ignore-next-line code-duplication
export function useActivityFeed(refreshMs: number = ACTIVITY_REFRESH_MS): ActivityFeed {
  const [feed, setFeed] = useState<ActivityFeed>(EMPTY)

  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const url = `/api/stats/activity-matrix?tz=${encodeURIComponent(viewerTimeZone())}&days=${ACTIVITY_DEFAULT_DAYS}`
    let body: unknown = null
    try {
      const res = await fetch(url, { credentials: 'same-origin' })
      if (res.ok) body = await res.json()
    } catch {
      body = null
    }
    if (!live.current) return false
    // A 403 or a body that is not a matrix keeps whatever we last knew. Blanking
    // the grid on a failed re-read would turn "we could not ask" into "you did
    // nothing", which is the one reading this pane must never produce.
    if (!isMatrix(body)) {
      setFeed(prev => (prev.settled ? prev : { ...prev, settled: true }))
      return false
    }
    setFeed({ matrix: body, settled: true, stale: false })
    return true
  }, [])

  const { stale } = useWallRevive('activity', load, refreshMs)

  return useMemo(() => (feed.stale === stale ? feed : { ...feed, stale }), [feed, stale])
}
