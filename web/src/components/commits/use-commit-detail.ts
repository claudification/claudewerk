/**
 * One commit, fetched by hash.
 *
 * Split out of `commit-detail-body` when the hover preview needed the same
 * three lines. Two components fetching the same endpoint with two copies of the
 * cancellation dance is how one of them ends up handling a 404 differently from
 * the other, and only one of them gets the fix.
 *
 * THE READ IS A FUNCTION, THE HOOK IS A WRAPPER. THE WALL's in-wall detail
 * (`wall-commit-detail-in-wall`) has to be driven by the revive seam rather than
 * by its own mount effect, so it needs the request without React's opinion about
 * when to fire it -- and it must not be a fourth copy of this URL.
 */

import { useEffect, useState } from 'react'
import type { CommitRow } from '@/lib/commits'
import { appendShareParam } from '@/lib/share-mode'

export type CommitDetail =
  | { status: 'loading' }
  /** The backend answered and has no such commit. */
  | { status: 'missing' }
  | { status: 'ready'; commit: CommitRow }

/**
 * Read one commit.
 *
 * `null` means THE READ DID NOT LAND -- a dead broker, a 5xx, a body that was
 * not JSON. That is a different claim from a clean 404, and the wall depends on
 * the difference: a detail that treats "the broker is gone" as "no such commit"
 * would erase an open panel and call the erasure an answer.
 */
export async function fetchCommitDetail(hash: string): Promise<CommitDetail | null> {
  try {
    const res = await fetch(appendShareParam(`/api/commits/${encodeURIComponent(hash)}`))
    if (!res.ok) return res.status === 404 ? { status: 'missing' } : null
    const body = (await res.json()) as { commit?: CommitRow } | null
    return body?.commit ? { status: 'ready', commit: body.commit } : { status: 'missing' }
  } catch {
    return null
  }
}

export function useCommitDetail(hash: string): CommitDetail {
  const [detail, setDetail] = useState<CommitDetail>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setDetail({ status: 'loading' })
    void fetchCommitDetail(hash).then(next => {
      // A failed read is nothing to show, and these two callers have no second
      // chance to offer -- they say `missing`, exactly as they always did.
      if (!cancelled) setDetail(next ?? { status: 'missing' })
    })
    return () => {
      cancelled = true
    }
  }, [hash])

  return detail
}
