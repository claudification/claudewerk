/**
 * AdvisorCard -- inline transcript card for a CC advisor() consult event.
 *
 * One card per TranscriptAdvisorEntry (advisor_message / advisor_result /
 * advisor_tool_result / advisor_redacted_result / advisor_tool_result_error).
 * The worker consulted a stronger model (Fable mid-task); this surfaces the
 * consult + verdict in the transcript (EVERYTHING IS A STRUCTURED MESSAGE).
 * The (i) button opens the full raw payload in JsonInspector.
 *
 * Mirrors ShellReceipt's treatment (lifecycle-card family).
 */
import type { TranscriptAdvisorEntry } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import type { DisplayGroup } from './grouping'
import { TimeStamp } from './timestamp'

export function AdvisorCard({ group }: { group: DisplayGroup }) {
  const entry = group.entries[0] as TranscriptAdvisorEntry
  const failed = entry.isError === true
  const cardStyle = failed ? 'border-amber-500/40 bg-amber-500/5' : 'border-violet-500/40 bg-violet-500/5'
  const chipStyle = failed
    ? 'bg-amber-500/20 text-amber-200 border-amber-500/40'
    : 'bg-violet-500/20 text-violet-200 border-violet-500/40'
  const label = `ADVISOR ${entry.advisorSubtype}`.toUpperCase().trim()

  return (
    <div className={cn('mb-2 px-3 py-2 rounded-md border font-mono text-[11px]', cardStyle)}>
      <div className="flex items-center gap-2">
        <span className={cn('inline-block w-1.5 h-1.5 rounded-full', failed ? 'bg-amber-400' : 'bg-violet-400')} />
        <span className={cn('px-1.5 py-0.5 text-[10px] font-bold uppercase rounded border', chipStyle)}>{label}</span>
        {entry.advisorModel && <span className="text-foreground/80 text-[10px]">{entry.advisorModel}</span>}
        <span className="flex-1" />
        <TimeStamp ts={entry.timestamp} className="text-muted-foreground text-[10px]" />
        {entry.raw && <JsonInspector data={entry.raw} title={`advisor ${entry.advisorSubtype}`} />}
      </div>
      {entry.redacted && <div className="text-amber-300/80 text-[10px] mt-1">advice redacted by safety classifier</div>}
      {entry.text && (
        <div className="text-foreground/85 text-[11px] mt-1.5 whitespace-pre-wrap leading-snug">{entry.text}</div>
      )}
    </div>
  )
}
