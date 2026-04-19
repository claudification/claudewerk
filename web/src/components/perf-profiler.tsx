/**
 * Shared <MaybeProfiler> wrapper.
 *
 * Wraps children in React.Profiler ONLY when the perf monitor toggle
 * (dashboardPrefs.showPerfMonitor) is on. Profiler adds an extra fiber
 * + measurement on every commit, so the gate matters.
 *
 * Profile data feeds the perf-metrics ring buffer (perf-metrics.ts) under
 * the 'render' category, where the perf HUD reads it.
 */

import { Fragment, Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { record } from '@/lib/perf-metrics'

const onRenderProfile: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration) => {
  record('render', id, actualDuration, `${phase} base=${baseDuration.toFixed(1)}ms`)
}

/**
 * Read showPerfMonitor inline so callers don't have to pass it down. The
 * subscription is cheap (single boolean) and only the wrapper re-renders
 * when the toggle flips, not its children.
 */
export function MaybeProfiler({ id, children }: { id: string; children: ReactNode }) {
  const enabled = useSessionsStore(s => s.dashboardPrefs.showPerfMonitor)
  if (!enabled) return <Fragment>{children}</Fragment>
  return (
    <Profiler id={id} onRender={onRenderProfile}>
      {children}
    </Profiler>
  )
}

/**
 * Variant for callers that already have the boolean and want the extra
 * detail string in the perf log (e.g. transcript view's visible-item count).
 */
export function MaybeProfilerWithCallback({
  enabled,
  id,
  onRender,
  children,
}: {
  enabled: boolean
  id: string
  onRender: ProfilerOnRenderCallback
  children: ReactNode
}) {
  if (!enabled) return <Fragment>{children}</Fragment>
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  )
}
