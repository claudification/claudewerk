import type { FoldStats } from './fork-api'
import { foldReductionPct, formatTokens } from './fork-strategy'

/**
 * What the fold actually bought, shown between forking and launching so the
 * user commits with the real numbers rather than a promise.
 */
export function FoldStatsReadout({ stats }: { stats: FoldStats }) {
  const pct = foldReductionPct(stats.beforeTokens, stats.afterTokens)
  const folded = stats.digestedResults + stats.collapsedReads

  return (
    <div className="rounded border border-emerald-400/30 bg-emerald-400/5 px-2.5 py-2 space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-mono text-foreground">
          {formatTokens(stats.beforeTokens)} <span className="text-comment">-&gt;</span>{' '}
          <span className="text-emerald-400 font-bold">{formatTokens(stats.afterTokens)}</span> tokens
        </span>
        {pct > 0 && <span className="text-[10px] font-mono text-emerald-400 tabular-nums">-{pct}%</span>}
      </div>
      <div className="text-[9px] text-comment leading-snug">
        {stats.entriesBefore} -&gt; {stats.entriesAfter} messages
        {folded > 0 && <> - {folded} tool outputs digested</>}
        {stats.droppedThinking > 0 && <> - {stats.droppedThinking} thinking blocks dropped</>}
      </div>
      <div className="text-[9px] text-comment/80 leading-snug">
        The original conversation is untouched and still resumable.
      </div>
    </div>
  )
}
