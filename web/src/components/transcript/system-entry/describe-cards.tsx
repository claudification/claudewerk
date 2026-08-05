import { parseRecapContent } from '@shared/recap'
import { JsonInspector } from '../../json-inspector'
import { BgTasksHint } from '../bg-tasks-hint'
import { TimeStamp } from '../timestamp'
import type { SystemDescriber } from './types'
import { str } from './types'

/**
 * The two subtypes that render a full-width bordered CARD instead of a line.
 * Because they own their own chrome, they must draw their own timestamp +
 * JsonInspector -- SystemLine only supplies those for `kind: 'text'` results.
 * The grouper keeps both out of assistant groups for the same reason
 * (see process-entry.ts).
 */
const awaySummary: SystemDescriber = (entry, ts) => {
  const parsed = parseRecapContent(str(entry.content))
  return {
    kind: 'jsx',
    node: (
      <div className="my-3 mx-auto max-w-[95%]">
        <div className="border border-zinc-600/40 bg-zinc-800/30 rounded px-4 py-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[9px] font-bold font-mono uppercase tracking-widest text-zinc-400/70">recap</span>
            <span className="flex-1 h-px bg-zinc-600/30" />
            <TimeStamp ts={ts} className="text-muted-foreground/40 text-[10px]" />
            <JsonInspector title="away_summary" data={entry} raw={entry} />
          </div>
          <div className="text-[11px] text-zinc-300/80 leading-relaxed">
            {parsed.title && <span className="font-medium text-zinc-200/90">{parsed.title}: </span>}
            {parsed.recap}
          </div>
        </div>
      </div>
    ),
  }
}

export const CARD_DESCRIBERS: Record<string, SystemDescriber> = {
  away_summary: awaySummary,
  background_tasks_changed: (entry, ts) => ({ kind: 'jsx', node: <BgTasksHint entry={entry} ts={ts} /> }),
}
