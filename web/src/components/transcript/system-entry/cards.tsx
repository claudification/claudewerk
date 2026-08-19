import { parseRecapContent } from '@shared/recap'
import type { SystemEntry } from '@shared/system-events'
import { JsonInspector } from '../../json-inspector'
import { TimeStamp } from '../timestamp'

// Kinds that draw their own bordered block instead of a line. They own their chrome, so they
// must draw their own timestamp + JsonInspector -- SystemLine supplies those only for lines.
// The grouper keeps them out of assistant groups for the same reason (see process-entry.ts).

export function AwaySummaryCard({ entry, ts }: { entry: SystemEntry; ts?: string | number }) {
  const parsed = parseRecapContent(typeof entry.content === 'string' ? entry.content : '')
  return (
    <div className="my-3 mx-auto max-w-[95%]">
      <div className="border border-zinc-600/40 bg-zinc-800/30 rounded px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[9px] font-bold font-mono uppercase tracking-widest text-zinc-400/70">recap</span>
          <span className="flex-1 h-px bg-zinc-600/30" />
          <TimeStamp ts={ts} className="text-fg-faint text-[10px]" />
          <JsonInspector title="away_summary" data={entry} raw={entry} />
        </div>
        <div className="text-[11px] text-zinc-300/80 leading-relaxed">
          {parsed.title && <span className="font-medium text-zinc-200/90">{parsed.title}: </span>}
          {parsed.recap}
        </div>
      </div>
    </div>
  )
}
