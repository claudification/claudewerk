/**
 * Perf report builder -- the single source for the markdown report shared by
 * the Perf tab's Copy button and the `web_perf_report` MCP tool. Three sections:
 *
 *   ## Summary    -- per-category count / avg / p95 / max (tab-hidden excluded)
 *   ## By message -- per-message-type impact rollup (messageImpactStats)
 *   ## Timeline   -- perf entries + debug-log lines interleaved chronologically,
 *                    so chunk loads / nav / sync sit next to the spikes they
 *                    explain (a raw number without this context misleads -- see
 *                    the rAF-suspension misread in plan-transcript-switch-perf).
 */

import { getLogEntries } from './debug-log'
import { categoryStats, getEntries, type PerfCategory, type PerfEntry } from './perf-metrics'
import { messageImpactStats } from './perf-rollup'

export const PERF_CATEGORIES: PerfCategory[] = ['render', 'grouping', 'ws', 'scroll', 'transcript', 'message', 'other']

/** Entries below this are noise; the report (and HUD) can filter to "significant only". */
export const SIGNIFICANT_THRESHOLD_MS = 2.5

export interface PerfReportOptions {
  /** Only include entries >= SIGNIFICANT_THRESHOLD_MS in By message + Timeline. */
  significantOnly?: boolean
  /** ISO timestamp stamped at the top. Defaults to now. */
  now?: string
}

export function buildPerfReport(opts: PerfReportOptions = {}): string {
  const significantOnly = opts.significantOnly ?? false
  const entries = getEntries() as PerfEntry[]
  const visibleEntries = significantOnly ? entries.filter(e => e.durationMs >= SIGNIFICANT_THRESHOLD_MS) : entries
  // react-doctor-disable-next-line react-doctor/rendering-hydration-mismatch-time
  const lines: string[] = ['# Perf Report', '', opts.now ?? new Date().toISOString(), '']

  const stats = PERF_CATEGORIES.flatMap(cat => {
    const s = categoryStats(cat)
    return s.count > 0 ? [{ cat, ...s }] : []
  })
  if (stats.length > 0) {
    lines.push('## Summary', '', '| Category | Count | Avg | P95 | Max |', '|---|---|---|---|---|')
    for (const s of stats) {
      lines.push(`| ${s.cat} | ${s.count} | ${s.avg.toFixed(1)}ms | ${s.p95.toFixed(1)}ms | ${s.max.toFixed(1)}ms |`)
    }
    lines.push('')
  }

  const impact = messageImpactStats(visibleEntries)
  if (impact.length > 0) {
    lines.push(
      '## By message',
      '',
      '| Message | n | Apply | Render | Paint | Group | Total |',
      '|---|---|---|---|---|---|---|',
    )
    for (const r of impact) {
      lines.push(
        `| ${r.msgType} | ${r.applies} | ${r.applyMs.toFixed(1)}ms | ${r.renderMs.toFixed(1)}ms | ${r.paintMs.toFixed(1)}ms | ${r.groupingMs.toFixed(1)}ms | ${r.totalMs.toFixed(1)}ms |`,
      )
    }
    lines.push('')
  }

  const iso = (t: number) => new Date(t).toISOString().slice(11, 23)
  type Row = { t: number; line: string }
  const perfRows: Row[] = visibleEntries.slice(-300).map(e => ({
    t: e.t,
    line: `${iso(e.t)}  ${e.category.padEnd(9)} ${e.label} ${e.durationMs.toFixed(1)}ms${e.msgType ? ` <${e.msgType}>` : ''}${e.detail ? ` ${e.detail}` : ''}`,
  }))
  const logRows: Row[] = getLogEntries()
    .slice(-400)
    .map(l => ({
      t: l.t,
      line: `${iso(l.t)}  ${l.level.toUpperCase().padEnd(9)} ${l.args.replace(/\s+/g, ' ').slice(0, 240)}`,
    }))
  const merged = [...perfRows, ...logRows].sort((a, b) => a.t - b.t).slice(-500)
  const heading = significantOnly
    ? `## Timeline (perf ≥${SIGNIFICANT_THRESHOLD_MS}ms + debug log, chronological)`
    : '## Timeline (perf + debug log, chronological)'
  lines.push(heading, '', '```', ...merged.map(r => r.line), '```')

  return lines.join('\n')
}
