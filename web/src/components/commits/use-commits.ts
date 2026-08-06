/**
 * Commit-ledger fetch hook. One place for the load / abort / live-append
 * lifecycle so both the conversation tab and the project section behave the
 * same way.
 *
 * Live updates ride the `commit_recorded` broadcast the broker emits on ingest
 * (EVERYTHING IS A STRUCTURED MESSAGE) -- no polling.
 */

import { useCallback, useEffect, useState } from 'react'
import { type CommitList, type CommitListParams, type CommitRow, fetchCommits } from '@/lib/commits'

/** Does a freshly-recorded commit belong in this view? Mirrors the broker's
 *  own filter: conversation match, or project match on EITHER URI. */
function belongsHere(commit: CommitRow, params: CommitListParams): boolean {
  if (params.conversationId) return commit.conversationId === params.conversationId
  if (params.projectUris?.length) {
    return params.projectUris.some(uri => uri === commit.repoUri || uri === commit.cwdUri)
  }
  return true
}

export function useCommits(params: CommitListParams, enabled = true): CommitList & { loading: boolean } {
  const [state, setState] = useState<CommitList>({ commits: [], total: 0 })
  const [loading, setLoading] = useState(enabled)

  const key = JSON.stringify(params)

  const load = useCallback(
    (signal?: AbortSignal) => {
      const parsed = JSON.parse(key) as CommitListParams
      return fetchCommits(parsed, signal).then(result => {
        if (!signal?.aborted) {
          setState(result)
          setLoading(false)
        }
      })
    },
    [key],
  )

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoading(true)
    void load(controller.signal).catch(() => setLoading(false))
    return () => controller.abort()
  }, [enabled, load])

  // Live append. A commit that arrives while a text search is active is NOT
  // spliced in blind -- it may not match the query, and showing a non-matching
  // row would quietly lie about what the search returned.
  useEffect(() => {
    if (!enabled) return
    const parsed = JSON.parse(key) as CommitListParams
    if (parsed.text) return

    const onRecorded = (event: Event) => {
      const commit = (event as CustomEvent<{ commit?: CommitRow }>).detail?.commit
      if (!commit || !belongsHere(commit, parsed)) return
      setState(prev =>
        prev.commits.some(c => c.hash === commit.hash)
          ? prev
          : { commits: [commit, ...prev.commits], total: prev.total + 1 },
      )
    }
    window.addEventListener('rclaude-commit-recorded', onRecorded)
    return () => window.removeEventListener('rclaude-commit-recorded', onRecorded)
  }, [enabled, key])

  return { ...state, loading }
}
