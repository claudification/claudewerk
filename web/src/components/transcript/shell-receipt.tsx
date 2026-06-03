/**
 * ShellReceipt -- inline transcript receipt for a host-shell lifecycle event.
 *
 * One card per TranscriptShellEntry: `open` (shell spawned at a path) or `exit`
 * (PTY exited, with code). Live bytes are never persisted -- only these two
 * structured receipts land in the transcript (EVERYTHING IS A STRUCTURED
 * MESSAGE). The (i) button opens the full `raw` payload in JsonInspector.
 *
 * Mirrors SpawnNotification's treatment (boot/launch family).
 */
import type { TranscriptShellEntry } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import type { DisplayGroup } from './grouping'
import { TimeStamp } from './timestamp'

const OPEN_STYLE = {
  card: 'border-emerald-500/40 bg-emerald-500/5',
  chip: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40',
  dot: 'bg-emerald-400',
}
const EXIT_OK_STYLE = {
  card: 'border-muted/40 bg-muted/5',
  chip: 'bg-muted/20 text-muted-foreground border-muted/40',
  dot: 'bg-muted-foreground',
}
const EXIT_ERR_STYLE = {
  card: 'border-amber-500/40 bg-amber-500/5',
  chip: 'bg-amber-500/20 text-amber-200 border-amber-500/40',
  dot: 'bg-amber-400',
}

export function ShellReceipt({ group }: { group: DisplayGroup }) {
  const entry = group.entries[0] as TranscriptShellEntry
  const isOpen = entry.event === 'open'
  const failed = !isOpen && typeof entry.code === 'number' && entry.code !== 0
  const style = isOpen ? OPEN_STYLE : failed ? EXIT_ERR_STYLE : EXIT_OK_STYLE
  const label = isOpen ? 'SHELL OPENED' : failed ? `SHELL EXIT ${entry.code}` : 'SHELL CLOSED'
  const path = entry.path || entry.projectUri || ''

  return (
    <div className={cn('mb-2 px-3 py-2 rounded-md border font-mono text-[11px]', style.card)}>
      <div className="flex items-center gap-2">
        <span className={cn('inline-block w-1.5 h-1.5 rounded-full', style.dot)} />
        <span className={cn('px-1.5 py-0.5 text-[10px] font-bold uppercase rounded border', style.chip)}>{label}</span>
        {entry.title && <span className="text-foreground/80 text-[10px]">{entry.title}</span>}
        <span className="text-amber-300/90 truncate flex-1">{path}</span>
        <TimeStamp ts={entry.timestamp} className="text-muted-foreground text-[10px]" />
        {entry.raw && <JsonInspector data={entry.raw} title={`shell ${entry.shellId.slice(0, 8)}`} />}
      </div>
      {entry.detail && <div className="text-muted-foreground text-[10px] mt-1">{entry.detail}</div>}
      {entry.createdBy && isOpen && (
        <div className="text-emerald-300/70 text-[9px] mt-1">opened by {entry.createdBy}</div>
      )}
    </div>
  )
}
