/** Charts off the persisted RecapDigest: cost-per-day, model mix, commit churn. */

import type { RecapDigest } from '@shared/protocol'
import { fmtCompact, fmtUsd } from './recap-format'

const MODEL_COLORS = ['var(--accent)', 'var(--success)', 'var(--warning)', 'var(--info)', 'var(--muted-foreground)']

function shortModel(m: string): string {
  return m
    .replace(/^anthropic\//, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
}

function CostPerDay({ perDay }: { perDay: RecapDigest['cost']['perDay'] }) {
  if (perDay.length < 2) return null
  const max = Math.max(...perDay.map(d => d.costUsd), 0.0001)
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Cost per day</div>
      <div className="flex h-20 items-end gap-1">
        {perDay.map(d => (
          <div
            key={d.day}
            className="group flex h-full flex-1 flex-col items-center justify-end"
            title={`${d.day}: ${fmtUsd(d.costUsd)} (${d.turns} turns)`}
          >
            <div
              className="w-full rounded-t bg-accent/70 transition-all group-hover:bg-accent"
              style={{ height: `${Math.max(2, (d.costUsd / max) * 100)}%` }}
            />
            <span className="mt-0.5 text-[9px] text-muted-foreground">{d.day.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelMix({ perModel }: { perModel: RecapDigest['cost']['perModel'] }) {
  if (!perModel.length) return null
  const total = perModel.reduce((s, m) => s + m.costUsd, 0) || 1
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Model mix (by cost)</div>
      <div className="flex h-3 w-full overflow-hidden rounded">
        {perModel.map((m, i) => (
          <div
            key={m.model}
            style={{ width: `${(m.costUsd / total) * 100}%`, background: MODEL_COLORS[i % MODEL_COLORS.length] }}
            title={`${shortModel(m.model)}: ${fmtUsd(m.costUsd)}`}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {perModel.map((m, i) => (
          <span key={m.model} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <span
              className="inline-block size-2 rounded-sm"
              style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
            />
            {shortModel(m.model)} {fmtUsd(m.costUsd)}
          </span>
        ))}
      </div>
    </div>
  )
}

export function RecapAnalytics({ digest }: { digest?: RecapDigest }) {
  if (!digest) return null
  const c = digest.commits
  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-muted/10 p-3">
      <CostPerDay perDay={digest.cost.perDay} />
      <ModelMix perModel={digest.cost.perModel} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>in {fmtCompact(digest.cost.totalInputTokens)} tok</span>
        <span>out {fmtCompact(digest.cost.totalOutputTokens)} tok</span>
        <span>cache rd {fmtCompact(digest.cost.totalCacheReadTokens)} tok</span>
        {c && (
          <span className="text-foreground">
            {c.total} commits · {c.filesChanged} files ·{' '}
            <span className="text-success">+{fmtCompact(c.insertions)}</span>{' '}
            <span className="text-destructive">-{fmtCompact(c.deletions)}</span>
          </span>
        )}
      </div>
    </div>
  )
}
