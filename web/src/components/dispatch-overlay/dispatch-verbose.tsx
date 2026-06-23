import type { DispatchHistoryBlock } from '@shared/protocol'
import { useDispatchStore } from './dispatch-store'
import { DispatchTraces } from './dispatch-verbose-traces'

/** Short relative age for the last consolidation timestamp. */
function ago(ts: number | null): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex flex-col">
      <span className="text-[9.5px] uppercase tracking-wider text-comment/50">{label}</span>
      <span className="font-mono text-[12px] text-foreground/90">{value}</span>
    </span>
  )
}

/** One live state block (`<fleet>`, `<memory>`, `<pending>`, ...), collapsible. */
function BlockPanel({ block }: { block: DispatchHistoryBlock }) {
  return (
    <details className="rounded-lg border border-border/60 bg-card/40 px-3 py-2" open>
      <summary className="cursor-pointer font-mono text-[11px] text-comment">
        {`<${block.tag}${block.id !== block.tag ? ` id=${block.id}` : ''}>`}
      </summary>
      <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground/80">
        {block.content}
      </pre>
    </details>
  )
}

/**
 * The VERBOSE state view (Slice D): exposes the dispatcher's full internal state
 * so Jonas can SEE why a discussion went the way it did -- the decision metadata,
 * the live XML state blocks (fleet/briefs/notes/memory/pending/findings), and the
 * per-turn tool frames. Lazy-loaded (covenant); rendered only when toggled on.
 */
// fallow-ignore-next-line complexity -- a presentational && chain; score is coverage-inflated, not real risk
function DispatchVerbose() {
  const history = useDispatchStore(s => s.history)
  const model = useDispatchStore(s => s.decisions[0]?.model)
  const blocks = history?.blocks ?? []

  return (
    <section className="flex max-h-[40%] flex-none flex-col gap-3 overflow-y-auto border-b border-border bg-background/60 px-6 py-3">
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <Stat label="ctx tokens" value={history?.estimatedTokens ?? 0} />
        <Stat label="window" value={`${history?.turns.length ?? 0} turns`} />
        <Stat label="transcript" value={`${history?.transcript.length ?? 0} turns`} />
        <Stat label="consolidated" value={ago(history?.lastConsolidatedAt ?? null)} />
        {model && <Stat label="model" value={model.split('/').pop() ?? model} />}
      </div>

      {blocks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[9.5px] uppercase tracking-wider text-comment/50">state blocks</span>
          {blocks.map(b => (
            <BlockPanel key={b.id} block={b} />
          ))}
        </div>
      )}

      <DispatchTraces />
    </section>
  )
}

export default DispatchVerbose
