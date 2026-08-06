/**
 * Transcript coverage -- which months live in the hot database and which have
 * been archived out to cold NDJSON.zst.
 *
 * Exists to answer one question fast: "why did my search find nothing for
 * March?" Without this, an archived month is indistinguishable from a month
 * that never happened.
 *
 * Admin-only server side; this just renders whatever it is allowed to see.
 */

import { useEffect, useState } from 'react'
import type { CoverageMonth, CoverageResponse } from './archive-coverage-types'
import { STATE_LABEL, stateOf } from './archive-coverage-types'

const STATE_CLS: Record<string, string> = {
  hot: 'text-foreground',
  both: 'text-foreground',
  cold: 'text-muted-foreground',
  gap: 'text-destructive',
}

function Row({ m }: { m: CoverageMonth }) {
  const state = stateOf(m)
  return (
    <div className="flex items-center gap-2 font-mono text-[10px] py-0.5">
      <span className="w-16 text-muted-foreground">{m.month}</span>
      <span className="w-20 text-right">{m.hotRows > 0 ? m.hotRows.toLocaleString() : '-'}</span>
      <span className="w-20 text-right text-muted-foreground">
        {m.coldRows !== null ? m.coldRows.toLocaleString() : '-'}
      </span>
      <span className={STATE_CLS[state]}>{STATE_LABEL[state]}</span>
    </div>
  )
}

export function ArchiveCoverageSection() {
  const [data, setData] = useState<CoverageResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/archives/coverage')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status === 403 ? 'admin only' : `HTTP ${r.status}`))))
      .then(d => {
        if (!cancelled) setData(d as CoverageResponse)
      })
      .catch(e => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <div className="text-[10px] text-muted-foreground">Coverage unavailable ({error}).</div>
  if (!data) return <div className="text-[10px] text-muted-foreground">Loading coverage...</div>
  if (!data.configured) {
    return <div className="text-[10px] text-muted-foreground">Cold archiving is not configured on this broker.</div>
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted-foreground leading-relaxed">
        Transcript months in the live database (hot) versus exported to immutable archives (cold). A cold month is still
        fully recoverable -- <span className="font-mono">broker-cli archive import</span> -- but it will not appear in
        search until it is imported back.
      </div>
      <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
        <span className="w-16">Month</span>
        <span className="w-20 text-right">Hot</span>
        <span className="w-20 text-right">Cold</span>
        <span>State</span>
      </div>
      <div>
        {data.months.map(m => (
          <Row key={m.month} m={m} />
        ))}
      </div>
      <div className="text-[10px] font-mono text-muted-foreground">
        {data.hotRows.toLocaleString()} hot / {data.coldRows.toLocaleString()} cold
        {data.gaps.length > 0 && <span className="text-destructive"> - gaps: {data.gaps.join(', ')}</span>}
      </div>
    </div>
  )
}
