import type { NightshiftTaskMeta } from '@shared/nightshift-types'

interface Props {
  task: NightshiftTaskMeta
}

function RiskBadge({ risk }: { risk?: string }) {
  if (!risk) return null
  const color = risk === 'low' ? 'text-green-400' : risk === 'medium' ? 'text-yellow-400' : 'text-red-400'
  return <span className={`text-xs font-mono uppercase ${color}`}>{risk} risk</span>
}

function TestsBadge({ tests }: { tests?: string }) {
  if (!tests || tests === 'none') return <span className="text-xs text-muted-foreground">no tests</span>
  const color = tests === 'pass' ? 'text-green-400' : 'text-red-400'
  return <span className={`text-xs font-mono ${color}`}>tests {tests}</span>
}

export function ReadyCard({ task }: Props) {
  return (
    <div className="rounded-md border border-border bg-card p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-sm leading-snug">{task.title}</span>
        <span className="shrink-0 text-xs font-mono text-muted-foreground">#{task.id}</span>
      </div>

      {task.branch && <div className="font-mono text-xs text-sky-400 truncate">{task.branch}</div>}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {task.diffstat && <span className="font-mono">{task.diffstat}</span>}
        {task.files && (
          <span>
            {task.files.length} file{task.files.length !== 1 ? 's' : ''}
          </span>
        )}
        <TestsBadge tests={task.tests} />
        <RiskBadge risk={task.risk} />
        {task.profile && <span>profile: {task.profile}</span>}
        {task.cost_usd !== undefined && <span>${task.cost_usd.toFixed(3)}</span>}
        {task.duration_min !== undefined && <span>{task.duration_min.toFixed(0)} min</span>}
      </div>

      {task.acceptance && <p className="text-xs text-muted-foreground italic">{task.acceptance}</p>}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled
          title="coming in P2 act-on-results"
          className="text-xs px-2 py-0.5 rounded border border-border text-muted-foreground cursor-not-allowed opacity-40"
        >
          diff
        </button>
        <button
          type="button"
          disabled
          title="coming in P2 act-on-results"
          className="text-xs px-2 py-0.5 rounded border border-border text-muted-foreground cursor-not-allowed opacity-40"
        >
          merge
        </button>
        <button
          type="button"
          disabled
          title="coming in P2 act-on-results"
          className="text-xs px-2 py-0.5 rounded border border-border text-muted-foreground cursor-not-allowed opacity-40"
        >
          reject
        </button>
      </div>
    </div>
  )
}
