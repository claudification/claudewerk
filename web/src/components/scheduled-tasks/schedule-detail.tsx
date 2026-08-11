/**
 * Right pane: one schedule in full, with its controls and its history.
 *
 * The header answers "is this thing working?" at a glance -- armed or not, when
 * it next runs (in the reader's clock), and how many times it has failed in a
 * row. The actions are the three you actually reach for: run it now, arm/disarm
 * it, or change it.
 */

import { describeWhen } from '@shared/describe-when'
import { nextFireAt } from '@shared/schedule-next-fire'
import type { ScheduledTask } from '@shared/scheduled-task'
import { useState } from 'react'
import { cn, haptic } from '@/lib/utils'
import { deleteScheduledTask, patchScheduledTask, runScheduledTaskNow } from './api'
import { NextFireLine } from './next-fires-preview'
import { RunHistory } from './run-history'

function Action({
  label,
  onClick,
  tone = 'default',
  busy,
}: {
  label: string
  onClick: () => void
  tone?: 'default' | 'primary' | 'danger'
  busy?: boolean
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        haptic('tap')
        onClick()
      }}
      className={cn(
        'px-2 py-1 text-[10px] font-mono rounded border transition-colors disabled:opacity-50',
        tone === 'primary' && 'border-primary/30 text-primary hover:bg-primary/10',
        tone === 'danger' && 'border-red-500/30 text-red-400 hover:bg-red-500/10',
        tone === 'default' && 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
}

export function ScheduleDetail({
  task,
  onEdit,
  onDeleted,
}: {
  task: ScheduledTask
  onEdit: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function withBusy(fn: () => Promise<{ ok: boolean; error?: string }>, okMessage: string) {
    setBusy(true)
    setFeedback(null)
    try {
      const res = await fn()
      setFeedback(res.ok ? okMessage : (res.error ?? 'failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className={cn('size-2 rounded-full shrink-0', task.enabled ? 'bg-primary' : 'bg-comment/40')} />
          <span className="text-sm font-mono font-bold text-foreground truncate">{task.name}</span>
        </div>
        <div className="text-[10px] font-mono text-comment">{describeWhen(task)}</div>
        <div className="text-[10px] font-mono text-muted-foreground">
          Next run:{' '}
          <NextFireLine
            ms={nextFireAt(task, Date.now())}
            tz={task.tz}
            never={task.enabled ? (task.runAt !== undefined ? 'already ran' : 'never') : 'disabled'}
          />
        </div>
        <div className="text-[10px] font-mono text-comment">
          {task.runCount} run{task.runCount === 1 ? '' : 's'}
          {task.consecutiveFailures > 0 && (
            <span className="text-red-400"> - {task.consecutiveFailures} failing in a row</span>
          )}
          {task.maxRuns !== undefined && <span> - stops after {task.maxRuns}</span>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Action
          label="Run now"
          tone="primary"
          busy={busy}
          onClick={() => withBusy(() => runScheduledTaskNow(task.id), 'launched')}
        />
        <Action
          label={task.enabled ? 'Disable' : 'Enable'}
          busy={busy}
          onClick={() =>
            withBusy(
              () => patchScheduledTask(task.id, { enabled: !task.enabled }),
              task.enabled ? 'disabled' : 'enabled',
            )
          }
        />
        <Action label="Edit" busy={busy} onClick={onEdit} />
        {confirmDelete ? (
          <Action
            label="Really delete?"
            tone="danger"
            busy={busy}
            onClick={() =>
              withBusy(async () => {
                const res = await deleteScheduledTask(task.id)
                if (res.ok) onDeleted()
                return res
              }, 'deleted')
            }
          />
        ) : (
          <Action label="Delete" tone="danger" busy={busy} onClick={() => setConfirmDelete(true)} />
        )}
      </div>

      {feedback && <div className="text-[10px] font-mono text-muted-foreground">{feedback}</div>}

      <div className="space-y-1">
        <div className="text-[9px] font-mono uppercase tracking-wider text-comment">Prompt</div>
        <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-words max-h-32 overflow-y-auto bg-surface-inset rounded p-2">
          {task.prompt}
        </pre>
      </div>

      <div className="space-y-1">
        <div className="text-[9px] font-mono uppercase tracking-wider text-comment">History</div>
        <RunHistory scheduleId={task.id} tz={task.tz} />
      </div>
    </div>
  )
}
