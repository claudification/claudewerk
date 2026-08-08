import { useCallback, useEffect, useState } from 'react'
import { type ArchivePlan, type ArchiveSearchResponse, fetchArchivePlan, searchColdArchives } from './archive-api'

/** The unindexed grep over archived months.
 *
 *  Never debounced and never automatic: it only runs when `run()` is called, and
 *  its result is cleared the moment the query changes, so a stale cold result
 *  can never sit under a different query pretending to belong to it.
 */
export function useColdSearch(open: boolean) {
  const [plan, setPlan] = useState<ArchivePlan | null>(null)
  const [result, setResult] = useState<ArchiveSearchResponse | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [includeToolOutput, setIncludeToolOutput] = useState(false)

  // The plan is cheap (reads the metas) and tells the user the price before they
  // pay it, so it loads with the dialog.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchArchivePlan().then(p => {
      if (!cancelled) setPlan(p)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const clear = useCallback(() => {
    setResult(null)
    setError('')
  }, [])

  const run = useCallback(
    async (query: string) => {
      if (!query.trim()) return
      setRunning(true)
      setError('')
      try {
        setResult(await searchColdArchives(query.trim(), { includeToolOutput }))
      } catch (err) {
        setResult(null)
        setError(err instanceof Error ? err.message : 'cold search failed')
      } finally {
        setRunning(false)
      }
    },
    [includeToolOutput],
  )

  const toggleToolOutput = useCallback(() => {
    setIncludeToolOutput(v => !v)
    // The previous result was produced under the other filter; keeping it on
    // screen next to the new toggle state would misrepresent it.
    setResult(null)
  }, [])

  return { plan, result, running, error, includeToolOutput, run, clear, toggleToolOutput }
}
