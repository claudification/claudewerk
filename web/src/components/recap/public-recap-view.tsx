/**
 * Public recap viewer mounted when the SPA enters share mode with
 * kind='recap'. Reads /shared/public/recap/:token (no auth, token is the
 * capability) and renders the markdown standalone -- no project chrome,
 * no sidebar, no header.
 */

import type { RecapDigest, RecapMetadata } from '@shared/protocol'
import { useEffect, useState } from 'react'
import { Markdown } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { RecapReport } from './recap-report'

interface PublicRecap {
  recapId: string
  title?: string
  subtitle?: string
  periodLabel: string
  periodStart: number
  periodEnd: number
  timeZone: string
  model?: string
  markdown: string
  // Recap 2.0 structured render data (absent on pre-2.0 shared recaps).
  metadata?: RecapMetadata
  digest?: RecapDigest
  llmCostUsd: number
  completedAt?: number
  shareLabel?: string
  expiresAt?: number
}

function formatRange(r: PublicRecap): string {
  const start = new Date(r.periodStart).toISOString().slice(0, 10)
  const end = new Date(r.periodEnd).toISOString().slice(0, 10)
  return start === end ? start : `${start} - ${end}`
}

type Mode = 'report' | 'writeup'

export function PublicRecapView({ token }: { token: string }) {
  const [state, setState] = useState<{ recap: PublicRecap | null; error: string | null; loading: boolean }>({
    recap: null,
    error: null,
    loading: true,
  })
  const [mode, setMode] = useState<Mode>('report')

  // scoped out of phase 7 PLAN (would need TanStack Query adoption)
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    let cancelled = false
    // Explicit JSON Accept: the endpoint serves server-rendered HTML for */*
    // (the no-JS fallback), so we must ask for JSON to get metadata + digest.
    fetch(`/shared/public/recap/${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' } })
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          setState({ recap: null, error: body.error || `share unavailable (${res.status})`, loading: false })
          return
        }
        const recap = (await res.json()) as PublicRecap
        setState({ recap, error: null, loading: false })
      })
      .catch(err => {
        if (cancelled) return
        setState({ recap: null, error: String(err), loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [token])

  if (state.loading) {
    return <div className="flex items-center justify-center min-h-screen text-sm text-muted-foreground">Loading…</div>
  }
  if (state.error || !state.recap) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 gap-2 text-center">
        <div className="text-base font-medium">Share unavailable</div>
        <div className="text-xs text-muted-foreground">{state.error || 'unknown error'}</div>
      </div>
    )
  }
  const r = state.recap
  // Tabs only make sense when there's a structured report to contrast with the
  // narrative write-up. Pre-2.0 recaps have no metadata/digest, so the report
  // already degrades to the markdown body -- a separate Write-up tab would just
  // duplicate it. The fork/regenerate controls from the in-app Write-up tab are
  // auth-gated ops features and are deliberately omitted from the public share.
  const hasReport = Boolean(r.metadata || r.digest)
  const showTabs = hasReport && Boolean(r.markdown)
  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <header className="mb-6 pb-4 border-b border-border">
          <h1 className="text-2xl font-semibold">{r.title || `Recap ${r.recapId.slice(0, 12)}`}</h1>
          {r.subtitle && <p className="italic text-muted-foreground mt-1">{r.subtitle}</p>}
          <p className="text-xs text-muted-foreground mt-2">
            {formatRange(r)} - {r.periodLabel}
            {r.model ? ` - ${r.model}` : ''}
            {r.expiresAt ? ` - share expires ${new Date(r.expiresAt).toISOString().slice(0, 10)}` : ''}
          </p>
        </header>
        {showTabs && (
          <div className="mb-5 flex gap-1.5" role="tablist" aria-label="Recap views">
            {(
              [
                { id: 'report', label: 'Report', title: 'Data-driven structured report' },
                { id: 'writeup', label: 'Write-up', title: 'Full narrative write-up & timeline' },
              ] as const
            ).map(t => {
              const active = mode === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={t.title}
                  onClick={() => setMode(t.id)}
                  className={cn(
                    'px-3 py-1 text-sm rounded border transition-colors',
                    active
                      ? 'border-accent bg-accent/15 text-foreground cursor-default'
                      : 'border-border text-muted-foreground hover:bg-muted/60 cursor-pointer',
                  )}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
        )}
        {showTabs && mode === 'writeup' ? (
          <Markdown copyable>{r.markdown}</Markdown>
        ) : (
          // When tabs are shown, the dedicated Write-up tab owns the narrative, so
          // suppress the report's inline write-up <details> to avoid duplication.
          <RecapReport metadata={r.metadata} digest={r.digest} markdown={r.markdown} hideWriteup={showTabs} />
        )}
      </div>
    </div>
  )
}
