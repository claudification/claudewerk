/**
 * The status badges on a project header row: LINK / PERM / WAITING / NOTIFY / SCHED.
 *
 * Extracted from `project-node.tsx` when SCHED was added -- that file was already
 * past its size bar and every new badge made the header markup harder to read.
 * Each badge is one fact about the project that deserves attention at a glance,
 * and they share a single visual language here rather than five inline copies.
 */

import { formatRelative } from '@shared/format-when'
import { nextFireAt } from '@shared/schedule-next-fire'
import { openScheduledTasksModal } from '@/components/scheduled-tasks/modal-state'
import { useScheduledTasksStore } from '@/components/scheduled-tasks/store'
import { cn } from '@/lib/utils'

function Badge({
  label,
  className,
  title,
  pulse,
  onClick,
}: {
  label: string
  className: string
  title?: string
  pulse?: boolean
  onClick?: (e: React.MouseEvent) => void
}) {
  const classes = cn('text-[9px] font-bold shrink-0', className, pulse && 'animate-pulse')
  if (!onClick) {
    return (
      <span className={classes} title={title}>
        {label}
      </span>
    )
  }
  return (
    <button type="button" className={cn(classes, 'hover:underline underline-offset-2')} title={title} onClick={onClick}>
      {label}
    </button>
  )
}

/**
 * SCHED: this project has armed schedules. The tooltip carries the soonest next
 * run in the READER's clock plus a countdown, because a bare cron in the sidebar
 * would be a riddle.
 */
function ScheduleBadge({ projectUri }: { projectUri: string }) {
  // Primitive selectors only -- this renders on every project row, and an object
  // literal here would re-render the whole sidebar on any store touch (React #185).
  const count = useScheduledTasksStore(s => {
    let n = 0
    for (const t of s.tasks) if (t.enabled && t.projectUri === projectUri) n++
    return n
  })
  const soonest = useScheduledTasksStore(s => {
    let best: number | null = null
    for (const t of s.tasks) {
      if (!t.enabled || t.projectUri !== projectUri) continue
      const next = nextFireAt(t, Date.now())
      if (next !== null && (best === null || next < best)) best = next
    }
    return best
  })

  if (count === 0) return null

  const title =
    soonest === null
      ? `${count} scheduled task${count === 1 ? '' : 's'}`
      : `${count} scheduled task${count === 1 ? '' : 's'} -- next ${formatRelative(soonest)}`

  return (
    <Badge
      label="SCHED"
      className="text-sky-400/80"
      title={title}
      onClick={e => {
        e.stopPropagation()
        openScheduledTasksModal(projectUri)
      }}
    />
  )
}

export function ProjectBadges({
  projectUri,
  hasPendingLink,
  hasPendingPermission,
  hasPendingAttention,
  hasNotification,
}: {
  projectUri: string
  hasPendingLink: boolean
  hasPendingPermission: boolean
  hasPendingAttention: boolean
  hasNotification: boolean
}) {
  return (
    <>
      {hasPendingLink && (
        <Badge
          label="LINK"
          className="text-teal-400"
          pulse
          title="A conversation in this project has a pending link request"
        />
      )}
      {hasPendingPermission && (
        <Badge
          label="PERM"
          className="text-amber-400"
          pulse
          title="A conversation in this project has a pending permission request"
        />
      )}
      {hasPendingAttention && !hasPendingPermission && <Badge label="WAITING" className="text-amber-400" pulse />}
      {hasNotification && <Badge label="NOTIFY" className="text-teal-400" />}
      <ScheduleBadge projectUri={projectUri} />
    </>
  )
}
