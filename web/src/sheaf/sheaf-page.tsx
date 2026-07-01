/**
 * Sheaf page -- full-screen 24/48h fleet overview.
 *
 * Lazy-loaded from app.tsx when the hash is `#/sheaf`. Read-only admin view
 * over `GET /api/sheaf`. No mutations.
 */

import type { SheafResponse } from '@shared/sheaf-types'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { costHeatClass, formatAgo, formatCost, formatDateTime, formatTokens } from './format'
import { SheafControlsRow } from './sheaf-controls'
import { WINDOW_OPTIONS } from './sheaf-derive'
import { ProjectSection } from './sheaf-project-section'
import { FleetSotuStats } from './sheaf-sotu'
import { type SheafFilters, useSheafFilters } from './use-sheaf-filters'
import { useSheafKeyboard } from './use-sheaf-keyboard'

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

  // Reset loading state synchronously on windowH/tick change (render-time adjustment)
  const [prevKey, setPrevKey] = useState({ windowH, tick })
  if (windowH !== prevKey.windowH || tick !== prevKey.tick) {
    setPrevKey({ windowH, tick })
    setState(s => ({ ...s, loading: true, error: null }))
  }

  useEffect(() => {
    let cancelled = false
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
  const allProjects = data?.projects ?? []
  const filters = useSheafFilters(allProjects)
  const filterRef = useRef<HTMLInputElement>(null)
  useSheafKeyboard({ filterRef, filter: filters.filter, clearFilter: filters.clearFilter, reload })

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground overflow-hidden">
      <Header
        windowH={windowH}
        onWindowH={setWindowH}
        onRefresh={reload}
        loading={loading}
        generatedAt={data?.generatedAt}
        filters={filters}
        filterRef={filterRef}
      />
      <Totals data={data} windowH={windowH} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[1600px] mx-auto p-4">
          <SheafBody
            error={error}
            loading={loading}
            data={data}
            windowH={windowH}
            now={now}
            filters={filters}
            reload={reload}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Body (states + project list) ─────────────────────────────────────

interface SheafBodyProps {
  error: string | null
  loading: boolean
  data: SheafResponse | null
  windowH: number
  now: number
  filters: SheafFilters
  reload: () => void
}

// fallow-ignore-next-line complexity
function SheafBody({ error, loading, data, windowH, now, filters, reload }: SheafBodyProps) {
  if (error) return <ErrorBanner error={error} onRetry={reload} />
  if (!data) return loading ? <Skeleton /> : null
  if (data.projects.length === 0) return <EmptyState windowH={windowH} />
  if (filters.visibleProjects.length === 0) {
    return <div className="text-center py-16 text-sm text-muted-foreground">No projects match the current filter.</div>
  }
  return <ProjectList filters={filters} now={now} />
}

function ProjectList({ filters, now }: { filters: SheafFilters; now: number }) {
  return (
    <div className="space-y-6">
      {filters.visibleProjects.map(p => (
        <ProjectSection
          key={p.projectUri}
          project={p}
          now={now}
          expanded={filters.expanded.has(p.projectUri)}
          onToggle={() => filters.toggleProject(p.projectUri)}
          showLineage={filters.showLineage}
          showRecaps={filters.showRecaps}
        />
      ))}
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
  filters: SheafFilters
  filterRef: React.RefObject<HTMLInputElement | null>
}

function Header({ windowH, onWindowH, onRefresh, loading, generatedAt, filters, filterRef }: HeaderProps) {
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
              {/* react-doctor-disable-next-line react-doctor/rendering-hydration-mismatch-time */}
              generated {formatDateTime(generatedAt)} ({formatAgo(Date.now() - generatedAt)})
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading} className="gap-1">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span className="text-xs hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>
      <SheafControlsRow filters={filters} filterRef={filterRef} />
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
        <Stat
          label="cost"
          value={formatCost(t.cost.amount, t.cost.estimated)}
          heatClass={costHeatClass(t.cost.amount)}
        />
        <FleetSotuStats sotu={data.sotu} />
      </div>
    </div>
  )
}

function Stat({ label, value, sub, heatClass }: { label: string; value: string; sub?: string; heatClass?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground/60 uppercase tracking-wide text-[10px]">{label}</span>
      <span className={`font-mono font-semibold ${heatClass ?? 'text-foreground'}`}>{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground/60 font-mono">{sub}</span>}
    </div>
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
