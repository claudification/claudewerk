/**
 * use-project-recent-ended - the project summary page's ended-conversation list.
 *
 * Ended conversations are no longer shipped on load (they were 2312 of 2367
 * rows), so this page cannot filter them out of the roster any more -- it asks
 * the broker for one project's worth. The broker bounds the answer with the
 * recent window: the newest 50 OR the last five days, whichever reaches further
 * back, capped at 500.
 *
 * Fetched on demand, per project. A conversation that ends during this session
 * is already in the roster, so it is merged in rather than waiting for a refetch.
 */

import { useEffect, useState } from 'react'
import type { Conversation } from '@/lib/types'

export interface RecentEndedState {
  conversations: Conversation[]
  loading: boolean
  error: string | null
}

/** Never rejects: an abort and a failure are both ordinary outcomes here. */
async function fetchProjectRecentEnded(
  projectUri: string,
  signal?: AbortSignal,
): Promise<{ conversations: Conversation[]; error: string | null }> {
  try {
    const url = `/conversations/recent?project=${encodeURIComponent(projectUri)}&status=ended`
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`recent conversations failed (${res.status})`)
    return { conversations: (await res.json()) as Conversation[], error: null }
  } catch (err) {
    return { conversations: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export function useProjectRecentEnded(projectUri: string, endedInRoster: Conversation[]): RecentEndedState {
  const [fetched, setFetched] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    fetchProjectRecentEnded(projectUri, controller.signal).then(result => {
      if (controller.signal.aborted) return // project switched mid-flight
      if (result.error) {
        // Surfaced rather than swallowed: an empty "Recent" section that is
        // actually a failed request reads as "this project has no history".
        setError(result.error)
      } else {
        setFetched(result.conversations)
      }
      setLoading(false)
    })

    return () => controller.abort()
  }, [projectUri])

  // Roster entries win on id: a conversation that ended moments ago carries
  // fresher state than the row the broker served before it ended.
  const byId = new Map(fetched.map(c => [c.id, c]))
  for (const conv of endedInRoster) byId.set(conv.id, conv)

  return {
    conversations: [...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity),
    loading,
    error,
  }
}
