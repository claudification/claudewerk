/**
 * Resolve a Draw block's INITIAL tldraw snapshot, once. Priority:
 *   1. an existing form value (user already drew, or a reload/switch restored it)
 *   2. the block's inline `content` (snapshot JSON string)
 *   3. the block's `contentUrl` (blob holding the snapshot JSON -- fetched)
 *
 * Re-resolves only when the agent patches `content`/`contentUrl` (a redraw), NOT
 * when the user's own edits churn the form value -- that would reset the canvas.
 * The seed form value is captured at mount by the caller and passed as `seed`.
 */

import { isDrawValue } from '@shared/draw'
import { useEffect, useState } from 'react'

export interface DrawInitialState {
  snapshot: unknown | null
  loading: boolean
  error: string | null
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function useDrawInitial(
  content: string | undefined,
  contentUrl: string | undefined,
  seed: unknown,
): DrawInitialState {
  const [state, setState] = useState<DrawInitialState>({ snapshot: null, loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    const done = (snapshot: unknown | null, error: string | null = null) => {
      if (!cancelled) setState({ snapshot, loading: false, error })
    }
    const fetchUrl = async (url: string) => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        done(await res.json())
      } catch (err) {
        done(null, String(err))
      }
    }

    setState(s => ({ ...s, loading: true }))
    if (isDrawValue(seed)) {
      if (seed.kind === 'draw') return void done(parseJson(seed.snapshot))
      void fetchUrl(seed.url)
      return () => {
        cancelled = true
      }
    }
    if (content !== undefined) return void done(parseJson(content))
    if (contentUrl) {
      void fetchUrl(contentUrl)
      return () => {
        cancelled = true
      }
    }
    done(null)
    return () => {
      cancelled = true
    }
    // `seed` is intentionally captured once by the caller; do not depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, contentUrl])

  return state
}
