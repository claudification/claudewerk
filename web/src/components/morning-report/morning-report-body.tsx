/**
 * The surface body: the brew, the ticks, and the button.
 *
 * OPENING THIS TRIGGERS NO SWEEP. It reads the report the schedule already
 * recorded and renders it. There is no verb on the wire from here that could
 * start one, which is what keeps "no brew this morning" a visible failure rather
 * than a panel that quietly computes something to show you.
 */

import { useEffect, useState } from 'react'
import { useSurfaceActivity } from '@/hooks/use-surface-activity'
import { morningReportActivity } from './morning-report-activity'
import { NoProposals, NoReportYet, NothingMoved } from './morning-report-empty'
import { MorningReportFooter } from './morning-report-footer'
import { MorningReportHeader } from './morning-report-header'
import { MorningReportSections } from './morning-report-sections'
import { isTickable } from './morning-report-selection'
import { MORNING_REPORT_MODAL } from './morning-report-state'
import { useMorningReport } from './use-morning-report'

/**
 * A clock that ticks slowly, purely so "this morning" becomes "from yesterday"
 * on a surface left parked overnight. Hourly: the label's smallest unit is a
 * day, so anything faster is a re-render nobody asked for.
 */
const AGE_REFRESH_MS = 3_600_000

function useSlowClock(): number {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), AGE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  return nowMs
}

export function MorningReportBody({ project }: { project: string | undefined }) {
  const state = useMorningReport(project)
  const nowMs = useSlowClock()

  // Say what we are looking at, so the dock tile can say it while we are parked
  // -- and pulse when a fresh brew lands behind our back.
  useSurfaceActivity(MORNING_REPORT_MODAL.id, morningReportActivity(state))

  const { report } = state
  if (state.loading && !report) {
    return <div className="p-4 text-xs text-muted-foreground">Reading the brew...</div>
  }
  if (!report) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {state.error && <div className="px-3 py-2 text-xs text-destructive">{state.error}</div>}
        <NoReportYet />
      </div>
    )
  }

  const executable = report.proposals.filter(isTickable)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MorningReportHeader report={report} nowMs={nowMs} />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {report.skipped ? (
          <NothingMoved idleReason={report.idleReason} />
        ) : report.proposals.length === 0 ? (
          <NoProposals idleReason={report.idleReason} />
        ) : (
          <MorningReportSections
            proposals={report.proposals}
            selection={state.selection}
            outcomes={state.outcomes}
            busy={state.executing}
            onToggle={state.toggleRow}
          />
        )}
      </div>

      {state.error && <div className="shrink-0 px-3 py-1 text-[10px] text-destructive">{state.error}</div>}

      {executable.length > 0 && (
        <MorningReportFooter
          proposals={report.proposals}
          selection={state.selection}
          executing={state.executing}
          onTickAll={state.onTickAll}
          onUntickAll={state.onUntickAll}
          onExecute={state.execute}
        />
      )}
    </div>
  )
}
