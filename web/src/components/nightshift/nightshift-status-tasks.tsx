// Per-task rows for the live nightshift Status screen (plan-nightshift.md §2.5):
// one row per night-run conversation -- status, elapsed, profile, turns/tokens,
// diffstat. Reads the live fleet (conversationsById), filtered by the night tag.
import type { Conversation } from '@/lib/types'
import { cn, formatDurationMs } from '@/lib/utils'

const STATUS_TONE: Record<string, string> = {
  active: 'text-active border-active/40',
  idle: 'text-warning border-warning/40',
  ended: 'text-muted-foreground border-border',
  starting: 'text-muted-foreground border-border',
  booting: 'text-muted-foreground border-border',
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tabular-nums',
        STATUS_TONE[status] ?? STATUS_TONE.ended,
      )}
    >
      {status}
    </span>
  )
}

function diffstat(c: Conversation): string | null {
  const added = c.stats?.linesAdded ?? 0
  const removed = c.stats?.linesRemoved ?? 0
  if (!added && !removed) return null
  return `+${added} -${removed}`
}

function TaskRow({ c, now }: { c: Conversation; now: number }) {
  const tokens = (c.stats?.totalInputTokens ?? 0) + (c.stats?.totalOutputTokens ?? 0)
  const ds = diffstat(c)
  return (
    <div className="flex items-center gap-2 border-t border-border/50 px-3 py-1.5 text-[11px]">
      <span className="w-8 shrink-0 font-mono text-muted-foreground">{c.nightshift?.taskId ?? '--'}</span>
      <StatusPill status={c.status} />
      <span className="min-w-0 flex-1 truncate" title={c.summary || c.id}>
        {c.summary?.trim() || c.title?.trim() || c.id.slice(0, 12)}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{formatDurationMs(now - c.startedAt)}</span>
      <span className="hidden shrink-0 font-mono text-muted-foreground sm:inline">
        {c.resolvedProfile ?? 'default'}
      </span>
      <span className="hidden w-14 shrink-0 text-right tabular-nums text-muted-foreground md:inline">
        {c.stats?.turnCount ?? 0} t
      </span>
      <span className="hidden w-20 shrink-0 text-right tabular-nums text-muted-foreground md:inline">
        {tokens.toLocaleString('en-US')}
      </span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{ds ?? ''}</span>
    </div>
  )
}

export function NightshiftStatusTasks({ tasks, now }: { tasks: Conversation[]; now: number }) {
  if (tasks.length === 0) {
    return <p className="px-3 py-4 text-[11px] text-muted-foreground">No night-run tasks for this project right now.</p>
  }
  // queued/running first (active/idle), then terminal -- newest start first within a band.
  const sorted = tasks.toSorted((a, b) => {
    const live = (c: Conversation) => (c.status === 'active' || c.status === 'idle' ? 0 : 1)
    return live(a) - live(b) || b.startedAt - a.startedAt
  })
  return (
    <div>
      {sorted.map(c => (
        <TaskRow key={c.id} c={c} now={now} />
      ))}
    </div>
  )
}
