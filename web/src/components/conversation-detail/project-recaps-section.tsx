/**
 * Collapsible "Recent recaps" section for the ProjectActionPanel. Shows
 * finished recaps for this project created within the last 3 days, each
 * row opening the recap viewer (rclaude-recap-open). A "See all" link
 * opens the full history modal (rclaude-recap-history-open). Renders
 * nothing when there are no recent recaps.
 */

import type { RecapSummary } from '@shared/protocol'
import { useEffect, useState } from 'react'
import { appendShareParam } from '@/lib/share-mode'
import { haptic } from '@/lib/utils'

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

interface ListResponse {
  recaps?: RecapSummary[]
}

async function fetchProjectRecaps(projectUri: string): Promise<RecapSummary[]> {
  const url = new URL('/api/recaps', window.location.origin)
  url.searchParams.set('projectUri', projectUri)
  url.searchParams.set('limit', '100')
  const res = await fetch(appendShareParam(url.pathname + url.search))
  if (!res.ok) return []
  const body = (await res.json()) as ListResponse
  return body.recaps ?? []
}

function recapAge(createdAt: number): string {
  const diff = Date.now() - createdAt
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function openRecap(recapId: string) {
  haptic('tap')
  window.dispatchEvent(new CustomEvent('rclaude-recap-open', { detail: { recapId } }))
}

function openHistory(projectUri: string) {
  haptic('tap')
  window.dispatchEvent(new CustomEvent('rclaude-recap-history-open', { detail: { projectUri } }))
}

export function ProjectRecapsSection({ projectUri }: { projectUri: string }) {
  const [recaps, setRecaps] = useState<RecapSummary[]>([])
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchProjectRecaps(projectUri).then(items => {
      if (!cancelled) setRecaps(items)
    })
    return () => {
      cancelled = true
    }
  }, [projectUri])

  const recent = recaps
    .filter(r => r.status === 'done' && Date.now() - r.createdAt < THREE_DAYS_MS)
    .sort((a, b) => b.createdAt - a.createdAt)

  // Hide the whole section when there is nothing recent to show.
  if (recent.length === 0) return null

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => {
          haptic('tap')
          setCollapsed(c => !c)
        }}
        className="w-full text-[10px] text-amber-400/70 font-bold uppercase tracking-wider px-1 flex items-center gap-2"
      >
        <span className="shrink-0 w-2 text-left">{collapsed ? '▸' : '▾'}</span>
        <span>Recent recaps ({recent.length})</span>
        <span className="flex-1 h-px bg-amber-400/20" />
      </button>
      {!collapsed && (
        <>
          {recent.map(r => (
            <button
              key={r.id}
              type="button"
              onClick={() => openRecap(r.id)}
              className="w-full text-left px-3 py-2 border border-border hover:border-amber-400/60 transition-colors space-y-0.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-amber-400/90 truncate flex-1">{r.title || r.id}</span>
                <span className="text-[10px] text-fg-muted shrink-0">{recapAge(r.createdAt)}</span>
              </div>
              {r.subtitle && (
                <div className="text-[11px] leading-relaxed text-muted-foreground truncate">{r.subtitle}</div>
              )}
              <div className="text-[9px] font-mono text-fg-dim uppercase tracking-wide">
                {r.periodLabel}
                {r.llmCostUsd > 0 && ` - $${r.llmCostUsd.toFixed(2)}`}
              </div>
            </button>
          ))}
          <button
            type="button"
            className="text-[10px] text-fg-dim hover:text-muted-foreground px-1 transition-colors"
            onClick={() => openHistory(projectUri)}
          >
            See all recaps
          </button>
        </>
      )}
    </div>
  )
}
