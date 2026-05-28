/** One-glance scorecard strip: the TL;DR-of-the-TL;DR for a recap. */

import type { RecapDigest, RecapMetadata } from '@shared/protocol'
import { fmtCompact, fmtUsd } from './recap-bits'

function Stat({ value, label, tone }: { value: string | number; label: string; tone?: string }) {
  return (
    <div className="flex min-w-[64px] flex-col items-center rounded-md border border-border bg-muted/20 px-3 py-2">
      <span className={`text-lg font-semibold tabular-nums ${tone ?? ''}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  )
}

export function RecapScorecard({ metadata, digest }: { metadata?: RecapMetadata; digest?: RecapDigest }) {
  const stats: Array<{ value: string | number; label: string; tone?: string }> = []
  if (metadata) {
    if (metadata.features.length)
      stats.push({ value: metadata.features.length, label: 'shipped', tone: 'text-success' })
    if (metadata.bugs.length) stats.push({ value: metadata.bugs.length, label: 'bugs fixed' })
    if (metadata.fixes.length) stats.push({ value: metadata.fixes.length, label: 'refactors' })
    if (metadata.incidents.length)
      stats.push({ value: metadata.incidents.length, label: 'incidents', tone: 'text-destructive' })
    if (metadata.decisions.length) stats.push({ value: metadata.decisions.length, label: 'decisions' })
    if (metadata.dead_ends.length)
      stats.push({ value: metadata.dead_ends.length, label: 'dead ends', tone: 'text-warning' })
  }
  if (digest) {
    if (digest.cost.totalCostUsd) stats.push({ value: fmtUsd(digest.cost.totalCostUsd), label: 'project cost' })
    if (digest.cost.totalTurns) stats.push({ value: fmtCompact(digest.cost.totalTurns), label: 'turns' })
    if (digest.conversations.length) stats.push({ value: digest.conversations.length, label: 'conversations' })
    if (digest.commits?.total) stats.push({ value: digest.commits.total, label: 'commits' })
  }
  if (!stats.length) return null

  const topTheme = metadata?.hashtags[0]
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {stats.map(s => (
          <Stat key={s.label} value={s.value} label={s.label} tone={s.tone} />
        ))}
      </div>
      {topTheme && <div className="text-xs text-muted-foreground">Theme: {topTheme}</div>}
    </div>
  )
}
