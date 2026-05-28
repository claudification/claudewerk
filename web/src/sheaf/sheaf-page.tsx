/**
 * Sheaf page -- full-screen 24/48h fleet overview.
 *
 * Lazy-loaded from app.tsx when the hash is `#/sheaf`. Read-only admin view
 * over `GET /api/sheaf`. No mutations.
 */

import { ArrowLeft, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SheafProject, SheafResponse } from '@shared/sheaf-types'
import { Button } from '@/components/ui/button'
import { formatAgo, formatCost, formatDateTime, formatDuration, formatTokens } from './format'
import { SheafTree } from './sheaf-tree'

const WINDOW_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d', hours: 168 },
]

interface SheafState {
  data: SheafResponse | null
  loading: boolean
  error: string | null
}

async function fetchSheaf(windowH: number): Promise<SheafResponse> {
  const res = await fetch(`/api/sheaf?windowH=${windowH}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`sheaf fetch failed: ${res.status} ${body.slice(0, 200)}`)
  }
  return (await res.json()) as SheafResponse
}

function useSheaf(windowH: number): SheafState & { reload: () => void } {
  const [state, setState] = useState<SheafState>({ data: null, loading: true, error: null })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState(s => ({ ...s, loading: true, error: null }))
    fetchSheaf(windowH)
      .then(data => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ data: null, loading: false, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [windowH, tick])

  const reload = useCallback(() => setTick(t => t + 1), [])
  return { ...state, reload }
}

function backToDashboard() {
  window.location.hash = ''
}

export function SheafPage() {
  const [windowH, setWindowH] = useState(24)
  const { data, loading, error, reload } = useSheaf(windowH)
  const now = data?.generatedAt ?? Date.now()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') backToDashboard()
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) reload()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reload])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground overflow-hidden">
      <Header windowH={windowH} onWindowH={setWindowH} onRefresh={reload} loading={loading} generatedAt={data?.generatedAt} />
      <Totals data={data} windowH={windowH} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[1600px] mx-auto px-4 py-4">
          {error && <ErrorBanner error={error} onRetry={reload} />}
          {!error && loading && !data && <Skeleton />}
          {!error && data && data.projects.length === 0 && <EmptyState windowH={windowH} />}
          {!error && data && data.projects.length > 0 && (
            <div className="space-y-6">
              {data.projects.map(p => (
                <ProjectSection key={p.projectUri} project={p} now={now} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Header ───────────────────────────────────────────────────────────

interface HeaderProps {
  windowH: number
  onWindowH: (h: number) => void
  onRefresh: () => void
  loading: boolean
  generatedAt: number | undefined
}

function Header({ windowH, onWindowH, onRefresh, loading, generatedAt }: HeaderProps) {
  return (
    <div className="shrink-0 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={backToDashboard} className="gap-1">
          <ArrowLeft className="size-4" />
          <span className="text-xs">Back</span>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">SHEAF</h1>
        <span className="text-xs text-muted-foreground hidden sm:inline">
          fleet overview, last {WINDOW_OPTIONS.find(w => w.hours === windowH)?.label ?? `${windowH}h`}
        </span>

        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center rounded border border-border overflow-hidden">
            {WINDOW_OPTIONS.map(opt => (
              <button
                key={opt.hours}
                type="button"
                onClick={() => onWindowH(opt.hours)}
                className={`px-2.5 py-1 text-xs font-mono transition-colors ${
                  windowH === opt.hours
                    ? 'bg-foreground/10 text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/5'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {generatedAt && (
            <span className="text-[10px] text-muted-foreground/70 hidden md:inline">
              generated {formatDateTime(generatedAt)} ({formatAgo(Date.now() - generatedAt)})
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading} className="gap-1">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span className="text-xs hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Totals strip ─────────────────────────────────────────────────────

function Totals({ data, windowH }: { data: SheafResponse | null; windowH: number }) {
  if (!data) {
    return (
      <div className="shrink-0 border-b border-border/50 bg-muted/10 px-4 py-2 text-xs text-muted-foreground">
        <div className="max-w-[1600px] mx-auto">last {windowH}h - loading…</div>
      </div>
    )
  }
  const t = data.totals
  const totalTokens = t.tokens.input + t.tokens.output + t.tokens.cache
  return (
    <div className="shrink-0 border-b border-border/50 bg-muted/10 px-4 py-2">
      <div className="max-w-[1600px] mx-auto flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs">
        <Stat label="window" value={`${windowH}h`} />
        <Stat label="projects" value={String(t.projects)} />
        <Stat label="conversations" value={String(t.conversations)} />
        <Stat label="trees" value={String(t.trees)} />
        <Stat
          label="tokens"
          value={formatTokens(totalTokens)}
          sub={`${formatTokens(t.tokens.input)}/${formatTokens(t.tokens.output)} (+${formatTokens(t.tokens.cache)}c)`}
        />
        <Stat label="cost" value={formatCost(t.cost.amount, t.cost.estimated)} highlight />
      </div>
    </div>
  )
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground/60 uppercase tracking-wide text-[10px]">{label}</span>
      <span className={`font-mono font-semibold ${highlight ? 'text-emerald-400' : 'text-foreground'}`}>{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground/60 font-mono">{sub}</span>}
    </div>
  )
}

// ─── Project section ──────────────────────────────────────────────────

function ProjectSection({ project, now }: { project: SheafProject; now: number }) {
  const totals = project.totals
  const totalTokens = totals.tokens.input + totals.tokens.output + totals.tokens.cache
  const worktreePills = useMemo(
    () =>
      project.worktrees.map(wt => ({
        key: wt.name ?? '(main)',
        label: wt.name ? `worktree:${wt.name}` : '(main)',
        convCount: wt.convCount,
        tokens: wt.tokens.input + wt.tokens.output + wt.tokens.cache,
        cost: wt.cost,
      })),
    [project.worktrees],
  )

  return (
    <section className="space-y-2">
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-background/90 backdrop-blur border-b border-border/60 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold tracking-tight truncate" title={project.projectUri}>
          {project.label}
        </h2>
        <span className="text-[10px] text-muted-foreground/70 font-mono truncate">{project.projectUri}</span>
        <div className="ml-auto flex items-baseline gap-x-4 text-xs">
          <span className="text-muted-foreground">
            <span className="font-mono font-semibold text-foreground">{totals.convCount}</span> convs
          </span>
          <span className="text-muted-foreground">
            <span className="font-mono font-semibold text-foreground">{totals.treeCount}</span> trees
          </span>
          <span className="text-muted-foreground">
            <span className="font-mono font-semibold text-foreground">{formatTokens(totalTokens)}</span> tok
          </span>
          <span className="font-mono font-semibold text-emerald-400">{formatCost(totals.cost.amount, totals.cost.estimated)}</span>
        </div>
      </div>

      {worktreePills.length > 1 && (
        <div className="flex flex-wrap gap-2 px-2 py-1">
          {worktreePills.map(pill => (
            <div
              key={pill.key}
              className="text-[10px] px-2 py-0.5 rounded border border-border/60 bg-muted/30 flex items-baseline gap-1.5"
            >
              <span className="font-mono">{pill.label}</span>
              <span className="text-muted-foreground/60">·</span>
              <span className="font-mono text-foreground">{pill.convCount} convs</span>
              <span className="text-muted-foreground/60">·</span>
              <span className="font-mono text-muted-foreground">{formatTokens(pill.tokens)}</span>
              <span className="text-muted-foreground/60">·</span>
              <span className="font-mono">{formatCost(pill.cost.amount, pill.cost.estimated)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {project.forest.map(root => (
          <SheafTree key={root.id} root={root} now={now} />
        ))}
      </div>
    </section>
  )
}

// ─── Misc states ──────────────────────────────────────────────────────

function ErrorBanner({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="border border-rose-500/30 bg-rose-500/10 rounded p-3 text-xs">
      <div className="font-semibold text-rose-300 mb-1">Sheaf failed to load</div>
      <div className="font-mono text-rose-200/80 break-all">{error}</div>
      <Button variant="ghost" size="sm" onClick={onRetry} className="mt-2">
        Retry
      </Button>
    </div>
  )
}

function EmptyState({ windowH }: { windowH: number }) {
  return (
    <div className="text-center py-16 text-muted-foreground">
      <div className="text-2xl mb-2">🌾</div>
      <div className="text-sm">No fleet activity in the last {windowH}h.</div>
      <div className="text-xs mt-1 opacity-70">All projects quiet.</div>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map(i => (
        <div key={i} className="border border-border/40 rounded p-3 animate-pulse">
          <div className="h-4 w-1/3 bg-muted/40 rounded mb-2" />
          <div className="h-3 w-2/3 bg-muted/30 rounded mb-1" />
          <div className="h-3 w-1/2 bg-muted/30 rounded" />
        </div>
      ))}
    </div>
  )
}

void formatDuration
