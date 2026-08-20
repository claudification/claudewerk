/**
 * One commit, fetched by hash.
 *
 * Split out of `commit-detail-body` when the hover preview needed the same
 * three lines. Two components fetching the same endpoint with two copies of the
 * cancellation dance is how one of them ends up handling a 404 differently from
 * the other, and only one of them gets the fix.
 */

import { useEffect, useState } from 'react'
import type { CommitRow } from '@/lib/commits'
import { appendShareParam } from '@/lib/share-mode'

export type CommitDetail =
  | { status: 'loading' }
  /** The backend answered and has no such commit. */
  | { status: 'missing' }
  | { status: 'ready'; commit: CommitRow }

export function useCommitDetail(hash: string): CommitDetail {
  const [detail, setDetail] = useState<CommitDetail>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setDetail({ status: 'loading' })
    void fetch(appendShareParam(`/api/commits/${encodeURIComponent(hash)}`))
      .then(res => (res.ok ? res.json() : null))
      .then((body: { commit?: CommitRow } | null) => {
        if (cancelled) return
        setDetail(body?.commit ? { status: 'ready', commit: body.commit } : { status: 'missing' })
      })
      .catch(() => !cancelled && setDetail({ status: 'missing' }))
    return () => {
      cancelled = true
    }
  }, [hash])

  return detail
}
