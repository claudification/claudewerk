/**
 * Pillar E COST 1 -- the PROJECT-cost showcase: mechanical activity rollups,
 * the cost-penalty-of-long-context curve, and the prompt-cache re-warm tax over
 * time. All fed by RecapDigest.activity / .contextBuckets / .cost.perDay (data
 * the broker already gathers). "Fantastic things to show a customer" -- so this
 * renders on the public share too (unlike the engine-cost footer).
 */

import type { RecapDigest, RecapDigestActivity, RecapDigestContextBucket } from '@shared/protocol'
import { fmtCompact, fmtUsd } from './recap-format'

function ToolSplit({ a }: { a: RecapDigestActivity }) {
  const t = a.toolCalls
  if (!t.total) return null
  const parts: Array<{ label: string; n: number; tone: string }> = [
    { label: 'read', n: t.read, tone: 'var(--info)' },
    { label: 'edit', n: t.edit, tone: 'var(--warning)' },
    { label: 'write', n: t.write, tone: 'var(--success)' },
    { label: 'bash', n: t.bash, tone: 'var(--accent)' },
    { label: 'other', n: t.other, tone: 'var(--muted-foreground)' },
  ].filter(p => p.n > 0)
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        Tool calls <span className="text-foreground">{fmtCompact(t.total)}</span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded">
        {parts.map(p => (
          <div
            key={p.label}
            style={{ width: `${(p.n / t.total) * 100}%`, background: p.tone }}
            title={`${p.label}: ${p.n}`}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {parts.map(p => (
          <span key={p.label} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="inline-block size-2 rounded-sm" style={{ background: p.tone }} />
            {p.label} {fmtCompact(p.n)}
          </span>
        ))}
      </div>
    </div>
  )
}

function ContextBuckets({ buckets }: { buckets: RecapDigestContextBucket[] }) {
  if (!buckets.length) return null
  const maxConv = Math.max(...buckets.map(b => b.conversations), 1)
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        Context reached (cost penalty &amp; re-warm tax)
      </div>
      <div className="flex flex-col gap-1">
        {buckets.map(b => {
          const perConv = b.conversations ? b.costUsd / b.conversations : 0
          return (
            <div key={b.bucket} className="flex items-center gap-2 text-[11px]">
              <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{b.bucket}</span>
              <div className="flex h-3 flex-1 items-center">
                <div
                  className="h-full rounded-sm bg-accent/70"
                  style={{ width: `${Math.max(3, (b.conversations / maxConv) * 100)}%` }}
                  title={`${b.conversations} conv · ${fmtUsd(b.costUsd)} · ${fmtUsd(perConv)}/conv · re-warm ${fmtCompact(b.cacheWriteTokens)} tok`}
                />
              </div>
              <span className="w-8 shrink-0 tabular-nums text-muted-foreground">{b.conversations}c</span>
              <span className="w-14 shrink-0 text-right tabular-nums">{fmtUsd(perConv)}/c</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CacheWriteSeries({ perDay }: { perDay: RecapDigest['cost']['perDay'] }) {
  const hasTax = perDay.some(d => d.cacheWriteTokens > 0)
  if (perDay.length < 2 || !hasTax) return null
  const max = Math.max(...perDay.map(d => d.cacheWriteTokens), 1)
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        Cache-write (re-warm) tax per day
      </div>
      <div className="flex h-16 items-end gap-1">
        {perDay.map(d => (
          <div
            key={d.day}
            className="group flex h-full flex-1 flex-col items-center justify-end"
            title={`${d.day}: ${fmtCompact(d.cacheWriteTokens)} cache-write tok`}
          >
            <div
              className="w-full rounded-t bg-warning/60 transition-all group-hover:bg-warning"
              style={{ height: `${Math.max(2, (d.cacheWriteTokens / max) * 100)}%` }}
            />
            <span className="mt-0.5 text-[9px] text-muted-foreground">{d.day.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** COST 1 project-metrics panel. Renders nothing when none of its inputs exist
 *  (pre-2.1 recaps), so it is safe to drop into the report unconditionally. */
export function RecapProjectMetrics({ digest }: { digest?: RecapDigest }) {
  if (!digest) return null
  const { activity, contextBuckets } = digest
  const hasCacheTax = digest.cost.perDay.length >= 2 && digest.cost.perDay.some(d => d.cacheWriteTokens > 0)
  if (!activity?.toolCalls.total && !activity?.incidents && !contextBuckets?.length && !hasCacheTax) return null
  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-muted/10 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Project activity</div>
      {activity && <ToolSplit a={activity} />}
      {activity && activity.incidents > 0 && (
        <div className="text-[11px] text-muted-foreground">
          <span className="text-destructive">{activity.incidents}</span> incident{activity.incidents === 1 ? '' : 's'}{' '}
          this period
        </div>
      )}
      {contextBuckets && <ContextBuckets buckets={contextBuckets} />}
      <CacheWriteSeries perDay={digest.cost.perDay} />
    </div>
  )
}
