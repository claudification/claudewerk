/**
 * DaemonRosterBrowser -- the ATTACH-mode worker picker for the spawn dialog.
 *
 * Lists every live daemon worker the broker has forwarded from the sentinel
 * roster (use-daemon-roster). Selecting one and launching attaches claudewerk
 * to that already-running worker -- no `claude --bg`, no config injection.
 * Terminal-state jobs (done/failed/stopped/crashed) are filtered out: they have
 * no live process to attach to.
 */

import { type DaemonRosterEntry, useDaemonRoster } from '@/hooks/use-daemon-roster'
import { shortenHomePath } from '@/lib/short-path'
import { cn, haptic } from '@/lib/utils'

/** Daemon job states with no live process -- not attachable. */
const TERMINAL_DAEMON_STATES = new Set(['done', 'failed', 'stopped', 'crashed'])

interface DaemonRosterBrowserProps {
  /** Currently-selected worker short, or undefined when nothing is picked. */
  selectedShort: string | undefined
  /** Fires with the picked worker, or null when the selection is cleared. */
  onSelect: (entry: DaemonRosterEntry | null) => void
}

/** Shorten an absolute path for display (home dir -> ~). */
function shortPath(cwd: string): string {
  return shortenHomePath(cwd)
}

/** Tailwind tint for a daemon job state. */
function stateClass(state: string): string {
  if (state === 'question' || state === 'blocked' || state === 'idle') return 'text-amber-400/90'
  if (state === 'starting' || state === 'resuming' || state === 'adopted') return 'text-sky-400/90'
  return 'text-emerald-400/90'
}

export function DaemonRosterBrowser({ selectedShort, onSelect }: DaemonRosterBrowserProps) {
  const { jobs, daemonPresent, hasRoster } = useDaemonRoster(true)
  const attachable = jobs.filter(j => !TERMINAL_DAEMON_STATES.has(j.state))

  if (!hasRoster) {
    return <div className="text-[10px] font-mono text-comment px-1 py-3">Loading daemon roster…</div>
  }

  if (!daemonPresent) {
    return (
      <div className="text-[10px] font-mono text-amber-400/80 bg-amber-950/20 border border-amber-400/30 rounded px-2 py-1.5 leading-snug">
        No <span className="text-foreground/90">claude daemon</span> running on the sentinel host. Start a worker with
        New mode, or run <span className="text-foreground/90">claude --bg</span> on the host.
      </div>
    )
  }

  if (attachable.length === 0) {
    return (
      <div className="text-[10px] font-mono text-comment px-2 py-3 border border-border rounded">
        No live daemon workers to attach to.
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-mono text-muted-foreground">
        Attach to a running daemon worker ({attachable.length})
      </div>
      <div className="max-h-[220px] overflow-y-auto border border-border rounded">
        {attachable.map(job => {
          const selected = job.short === selectedShort
          return (
            <button
              key={job.short}
              type="button"
              onClick={() => {
                onSelect(selected ? null : job)
                haptic('tap')
              }}
              className={cn(
                'w-full text-left px-2 py-1.5 text-[10px] font-mono border-b border-border last:border-b-0 transition-colors',
                selected
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-surface-inset hover:text-foreground',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-bold">{job.name || job.short}</span>
                <span className={cn('shrink-0', stateClass(job.state))}>{job.state}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[9px] text-comment">
                <span className="truncate">{shortPath(job.currentPath)}</span>
                <span className="shrink-0">{job.cliVersion ? `cli ${job.cliVersion}` : job.short}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
