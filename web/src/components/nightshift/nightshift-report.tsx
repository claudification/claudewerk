import type { NightshiftRunSnapshot } from '@shared/nightshift-types'
import { lazy, Suspense } from 'react'
import { BlockedCard } from './blocked-card'
import { ReadyCard } from './ready-card'
import { SkippedList } from './skipped-list'
import { useAct } from './use-act'

// Lazy: the ACT bar (+ its freeform textarea) ships only when a run is rendered.
const ActBar = lazy(() => import('./act-bar').then(m => ({ default: m.ActBar })))

function StatusBadge({ status }: { status: string }) {
  const color = status === 'done' ? 'text-green-400 border-green-800' : 'text-yellow-400 border-yellow-800'
  return <span className={`text-xs font-mono border rounded px-1.5 py-0.5 uppercase ${color}`}>{status}</span>
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-xs font-mono uppercase tracking-widest text-muted-foreground">{label}</h2>
      <span className="text-xs text-muted-foreground">({count})</span>
    </div>
  )
}

export function NightshiftReport({
  snapshot,
  projectUri,
}: {
  snapshot: NightshiftRunSnapshot
  projectUri: string | null
}) {
  const { run, tasks, blocked, skipped } = snapshot
  const readyTasks = tasks.filter(t => t.verdict === 'ready-to-review')
  const act = useAct(projectUri, run.runId)

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">{run.date}</span>
          <StatusBadge status={run.status} />
          {run.window && <span className="text-xs text-muted-foreground font-mono">{run.window}</span>}
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground font-mono">
          <span>ready: {run.totals.ready}</span>
          <span>blocked: {run.totals.blocked}</span>
          <span>skipped: {run.totals.skipped}</span>
          <span>errored: {run.totals.errored}</span>
          {run.runtime_min !== undefined && <span>runtime: {run.runtime_min.toFixed(0)} min</span>}
          {run.cost_usd !== undefined && <span>cost: ${run.cost_usd.toFixed(3)}</span>}
        </div>
      </div>

      {run.digest && (
        <div className="rounded-md border border-border bg-card p-4">
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{run.digest}</p>
        </div>
      )}

      <Suspense fallback={null}>
        <ActBar act={act} hasReady={readyTasks.length > 0} />
      </Suspense>

      {readyTasks.length > 0 && (
        <section>
          <SectionHeading label="Ready to review" count={readyTasks.length} />
          <div className="space-y-3">
            {readyTasks.map(t => (
              <ReadyCard key={t.id} task={t} act={act} />
            ))}
          </div>
        </section>
      )}

      {blocked.length > 0 && (
        <section>
          <SectionHeading label="Blocked -- needs you" count={blocked.length} />
          <div className="space-y-3">
            {blocked.map(b => (
              <BlockedCard key={b.id} item={b} />
            ))}
          </div>
        </section>
      )}

      {skipped.length > 0 && (
        <section>
          <SectionHeading label="Skipped" count={skipped.length} />
          <SkippedList items={skipped} />
        </section>
      )}
    </div>
  )
}
