/**
 * The brew, the ticks, and the press -- all the state the surface body holds.
 *
 * READ ONCE, ON ARMING. Not on a timer, not on every open, and never on a park /
 * restore: the surface's canvas stays mounted while it is docked, so this hook
 * is not re-run and the tick state survives by construction rather than by being
 * saved anywhere. The only thing that replaces a report is a `board_report_changed`
 * push, which is a sweep that genuinely happened.
 *
 * THE SELECTION IS KEYED TO A REPORT. When a newer brew arrives, the ticks are
 * re-defaulted from the new proposals rather than carried over: a tick means "I
 * looked at this row", and the rows just changed.
 */

import type { BoardApplyOutcome, BoardReportRecord } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { executeProposals, fetchLatestReport, onBoardReportChanged } from './morning-report-rpc'
import { defaultSelection, proposalKey, tickAll, tickedRefs, untickAll } from './morning-report-selection'

export interface MorningReportState {
  report: BoardReportRecord | null
  loading: boolean
  error: string | null
  executing: boolean
  /** What `apply` reported, keyed by proposal. Only ever set from a reply. */
  outcomes: Record<string, BoardApplyOutcome>
  selection: ReadonlySet<string>
  toggleRow: (key: string) => void
  onTickAll: () => void
  onUntickAll: () => void
  execute: () => void
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useMorningReport(project: string | undefined): MorningReportState {
  const [report, setReport] = useState<BoardReportRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [executing, setExecuting] = useState(false)
  const [outcomes, setOutcomes] = useState<Record<string, BoardApplyOutcome>>({})
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set<string>())

  // The report the ticks belong to. A newer brew re-defaults them; a re-render,
  // a park or a restore does not.
  const selectionFor = useRef<string | null>(null)
  const adopt = useCallback((next: BoardReportRecord | null) => {
    setReport(next)
    if (next && selectionFor.current !== next.date) {
      selectionFor.current = next.date
      setSelection(defaultSelection(next.proposals))
      setOutcomes({})
    }
  }, [])

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    if (!project) return
    let live = true
    setLoading(true)
    setError(null)
    fetchLatestReport(project)
      .then(next => {
        if (live) adopt(next)
      })
      .catch((e: unknown) => {
        if (live) setError(message(e))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
    // Arming only. The report is an artifact with a date on it -- refetching it
    // underneath a half-ticked list would silently change what Execute means.
  }, [project, adopt])

  // The live push. This is what makes a PARKED surface pulse: the sweep lands,
  // the body (still mounted, offscreen) adopts the new brew, and its reported
  // activity ticks over to the new date.
  useEffect(() => {
    if (!project) return
    return onBoardReportChanged(next => {
      if (next.project === project) adopt(next)
    })
  }, [project, adopt])

  const toggleRow = useCallback((key: string) => {
    setSelection(prev => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const onTickAll = useCallback(() => {
    setSelection(prev => (report ? tickAll(prev, report.proposals) : prev))
  }, [report])

  const onUntickAll = useCallback(() => setSelection(untickAll()), [])

  const execute = useCallback(() => {
    if (!project || !report || executing) return
    const refs = tickedRefs(selection, report.proposals)
    if (refs.length === 0) return
    setExecuting(true)
    setError(null)
    executeProposals(project, report.date, refs)
      .then(applied => {
        // Straight from the reply, which the broker built from what `apply` read
        // back off disk. Nothing here is derived from what was ticked.
        setOutcomes(prev => {
          const next = { ...prev }
          for (const outcome of applied) next[proposalKey(outcome)] = outcome
          return next
        })
        setSelection(prev => {
          const next = new Set(prev)
          for (const outcome of applied) if (outcome.ok) next.delete(proposalKey(outcome))
          return next
        })
      })
      .catch((e: unknown) => setError(message(e)))
      .finally(() => setExecuting(false))
  }, [project, report, selection, executing])

  return { report, loading, error, executing, outcomes, selection, toggleRow, onTickAll, onUntickAll, execute }
}
