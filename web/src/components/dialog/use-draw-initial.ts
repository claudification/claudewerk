/**
 * Resolve a Draw block's INITIAL Excalidraw scene, once. Priority:
 *   1. an existing form value (user already drew, or a reload/switch restored it)
 *   2. the block's inline `content` (scene JSON string)
 *   3. the block's `contentUrl` (blob holding the scene JSON -- fetched)
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

  // react-doctor-disable-next-line react-doctor/no-derived-state -- multi-source: state set synchronously on prop change AND asynchronously by fetch
  // Inline render-time adjustment: when content/contentUrl change, immediately
  // mark loading (no stale frame showing old snapshot). Synchronous resolution
  // paths (inline content, no-content fallback) also resolve here directly.
  const [prevContent, setPrevContent] = useState(content)
  const [prevContentUrl, setPrevContentUrl] = useState(contentUrl)
  if (content !== prevContent || contentUrl !== prevContentUrl) {
    setPrevContent(content)
    setPrevContentUrl(contentUrl)
    setState({ snapshot: null, loading: true, error: null })
  }

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

    if (isDrawValue(seed)) {
      // Restore the raw scene the user last had: inline kinds carry it, *-ref kinds
      // fetch it. (DSL is only the agent's SEED via `content`; a restored edit is raw.)
      if (seed.kind === 'draw' || seed.kind === 'excalidraw') return void done(parseJson(seed.snapshot))
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
