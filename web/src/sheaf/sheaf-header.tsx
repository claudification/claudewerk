/**
 * Sheaf toolbar + totals strip -- the chrome above the project list. The window
 * title/close live in the ModalSurface header; this owns the 24/48h window
 * toggle, refresh, generated-at stamp, filter controls, and the fleet totals.
 */

import type { SheafResponse } from '@shared/sheaf-types'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { costHeatClass, formatAgo, formatCost, formatDateTime, formatTokens } from './format'
import { SheafControlsRow } from './sheaf-controls'
import { WINDOW_OPTIONS } from './sheaf-derive'
import { FleetSotuStats } from './sheaf-sotu'
import type { SheafFilters } from './use-sheaf-filters'

interface ToolbarProps {
  windowH: number
  onWindowH: (h: number) => void
  onRefresh: () => void
  loading: boolean
  generatedAt: number | undefined
  filters: SheafFilters
  filterRef: React.RefObject<HTMLInputElement | null>
}

// fallow-ignore-next-line complexity
export function SheafToolbar({
  windowH,
  onWindowH,
  onRefresh,
  loading,
  generatedAt,
  filters,
  filterRef,
}: ToolbarProps) {
  return (
    <div className="shrink-0 border-b border-border bg-background/95">
      <div className="px-4 py-2 flex items-center gap-4">
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

export function SheafTotals({ data, windowH }: { data: SheafResponse | null; windowH: number }) {
  if (!data) {
    return (
      <div className="shrink-0 border-b border-border/50 bg-muted/10 px-4 py-2 text-xs text-muted-foreground">
        last {windowH}h - loading…
      </div>
    )
  }
  const t = data.totals
  const totalTokens = t.tokens.input + t.tokens.output + t.tokens.cache
  return (
    <div className="shrink-0 border-b border-border/50 bg-muted/10 px-4 py-2">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs">
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
