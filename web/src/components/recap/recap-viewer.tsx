/**
 * Recap viewer modal.
 *
 * Listens to the rclaude-recap-open CustomEvent (fired by the jobs widget,
 * the share viewer, and any future "open recap" trigger). Fetches the recap
 * over HTTP (so we don't double up on WS chatter) and renders the markdown
 * via the existing Markdown component.
 *
 * When the recap is still running, polls every 2s until status reaches a
 * terminal state. Live progress is also reflected via the recap-jobs store
 * (the widget already subscribes to recap_progress / recap_complete).
 */

import type { PeriodRecapDoc, RecapSummary } from '@shared/protocol'
import { Link2 } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { regenerateRecap } from '@/components/recap-jobs/recap-wire'
import { Kbd } from '@/components/ui/kbd'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useRecapJobsStore } from '@/hooks/use-recap-jobs'
import { appendShareParam } from '@/lib/share-mode'
import { cn, haptic } from '@/lib/utils'
import { fetchRecapList, modelLabel, selectSiblings } from './recap-forks'
import { recapOpenBus } from './recap-open-trigger'
import { RecapReport } from './recap-report'
import { RecapWriteupTab } from './recap-writeup-tab'
import type { RegenerateTuning } from './regenerate-recap-modal'

const POLL_MS = 2000

// Report = the data-driven structured render (the star). Write-up = the LLM
// narrative markdown (copyable). Raw = the markdown source verbatim.
type Mode = 'report' | 'writeup' | 'raw'

interface RecapDocResponse {
  recap?: PeriodRecapDoc
  error?: string
}

function isTerminal(status: PeriodRecapDoc['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

async function fetchRecap(recapId: string): Promise<PeriodRecapDoc | null> {
  const res = await fetch(appendShareParam(`/api/recaps/${encodeURIComponent(recapId)}`))
  if (!res.ok) return null
  const body = (await res.json()) as RecapDocResponse
  return body.recap ?? null
}

function formatPeriod(recap: PeriodRecapDoc): string {
  const start = new Date(recap.periodStart).toISOString().slice(0, 10)
  const end = new Date(recap.periodEnd).toISOString().slice(0, 10)
  return `${start} - ${end}`
}

function ActionButton({
  children,
  onClick,
  title,
  disabled = false,
  isLoading = false,
}: {
  children: React.ReactNode
  onClick: () => void | Promise<void>
  title?: string
  disabled?: boolean
  isLoading?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (disabled || isLoading) return
        haptic('tap')
        onClick()
      }}
      title={title}
      disabled={disabled || isLoading}
      className={`px-2 py-1 text-xs rounded border border-border transition-all ${
        disabled || isLoading ? 'opacity-50 cursor-not-allowed' : 'hover:bg-muted/60 cursor-pointer'
      }`}
    >
      {isLoading ? (
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  )
}

function copyMarkdown(recap: PeriodRecapDoc) {
  if (!recap.markdown) return
  navigator.clipboard.writeText(recap.markdown).catch(() => {})
}

function downloadMarkdown(recapId: string) {
  window.open(appendShareParam(`/api/recaps/${encodeURIComponent(recapId)}/markdown`), '_blank')
}

async function shareRecap(recapId: string): Promise<string | null> {
  const res = await fetch(appendShareParam(`/api/recaps/${encodeURIComponent(recapId)}/share`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) return null
  const body = (await res.json()) as { token?: string; shareUrl?: string }
  return body.shareUrl ?? (body.token ? `${window.location.origin}/r/${body.token}` : null)
}

function RecapHeader({ recap }: { recap: PeriodRecapDoc }) {
  const [isShareLoading, setIsShareLoading] = useState(false)
  // Active public share for THIS recap (recap-kind share targeting recap.recapId).
  // Primitive boolean selector -- never return an object from a Zustand selector.
  const isShared = useConversationsStore(s =>
    s.shares.some(sh => sh.targetKind === 'recap' && sh.targetId === recap.recapId && sh.expiresAt > Date.now()),
  )

  const handleShare = async () => {
    setIsShareLoading(true)
    try {
      const url = await shareRecap(recap.recapId)
      if (url) {
        try {
          await navigator.clipboard.writeText(url)
          haptic('success')
          window.dispatchEvent(
            new CustomEvent('rclaude-toast', {
              detail: {
                title: 'Copied',
                body: 'Share link copied to clipboard',
                variant: 'success',
              },
            }),
          )
        } catch {
          haptic('error')
          window.dispatchEvent(
            new CustomEvent('rclaude-toast', {
              detail: {
                title: 'Copy failed',
                body: 'Could not copy to clipboard',
                variant: 'error',
              },
            }),
          )
        }
      } else {
        haptic('error')
        window.dispatchEvent(
          new CustomEvent('rclaude-toast', {
            detail: {
              title: 'Share failed',
              body: 'Could not create share link',
              variant: 'error',
            },
          }),
        )
      }
    } finally {
      setIsShareLoading(false)
    }
  }

  return (
    <div className="px-4 pt-4 pb-2 border-b border-border shrink-0">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-semibold truncate">{recap.title || `Recap ${recap.recapId.slice(0, 12)}`}</h2>
            {isShared && (
              <span
                className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] uppercase font-bold bg-teal-500/20 text-teal-400 border border-teal-500/50"
                title="This recap has an active public share link"
              >
                <Link2 className="size-2.5" />
                shared
              </span>
            )}
          </div>
          {recap.subtitle && <p className="text-xs italic text-muted-foreground mt-0.5">{recap.subtitle}</p>}
          <p className="text-[11px] text-muted-foreground mt-1">
            {formatPeriod(recap)} - {recap.model || 'pending'} - cost ${recap.llmCostUsd.toFixed(4)}
          </p>
        </div>
        <DialogPrimitive.Close className="text-muted-foreground hover:text-foreground p-1" aria-label="Close">
          ✕
        </DialogPrimitive.Close>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton onClick={() => copyMarkdown(recap)} title="Copy markdown to clipboard">
          Copy markdown
        </ActionButton>
        <ActionButton onClick={() => downloadMarkdown(recap.recapId)} title="Download .md">
          Download .md
        </ActionButton>
        <ActionButton
          onClick={handleShare}
          isLoading={isShareLoading}
          title="Create a public share link and copy to clipboard"
        >
          Share link
        </ActionButton>
      </div>
    </div>
  )
}

const TABS: Array<{ id: Mode; label: string; title: string }> = [
  { id: 'report', label: 'Report', title: 'Data-driven structured report' },
  { id: 'writeup', label: 'Write-up', title: 'Full narrative write-up & timeline' },
  { id: 'raw', label: 'Raw', title: 'Raw markdown source' },
]

function RecapTabs({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="flex gap-1 px-4 pt-2 border-b border-border shrink-0" role="tablist">
      {TABS.map(t => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={mode === t.id}
          title={t.title}
          onClick={() => {
            haptic('tap')
            setMode(t.id)
          }}
          className={cn(
            'px-3 py-1.5 text-xs font-medium rounded-t border-b-2 -mb-px transition-colors',
            mode === t.id
              ? 'border-accent text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function StreamingState({ recap }: { recap: PeriodRecapDoc | null }) {
  // Pull live progress from the jobs store -- it has the freshest broker push.
  const job = useRecapJobsStore(s => (recap ? s.jobs[recap.recapId] : undefined))
  const status = job?.status ?? recap?.status ?? 'queued'
  const progress = job?.progress ?? recap?.progress ?? 0
  const phase = job?.phase ?? recap?.phase ?? ''
  return (
    <div className="px-4 py-6 text-center text-sm">
      <div className="mb-2 text-muted-foreground">
        Generating recap… {status} {phase ? `(${phase})` : ''}
      </div>
      <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden mx-auto max-w-md">
        <div
          className="h-full bg-cyan-500 transition-all"
          style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
        />
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{progress}%</div>
    </div>
  )
}

function toast(title: string, body: string, variant?: string) {
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail: { title, body, ...(variant ? { variant } : {}) } }))
}

export function RecapViewer() {
  const [recapId, setRecapId] = useState<string | null>(null)
  const [recap, setRecap] = useState<PeriodRecapDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('report')
  const [siblings, setSiblings] = useState<RecapSummary[]>([])
  const [regenerating, setRegenerating] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Stable read of the open recap id for the cross-render forked-event listener.
  const recapIdRef = useRef<string | null>(null)
  recapIdRef.current = recapId

  const close = useCallback(() => {
    setRecapId(null)
    setRecap(null)
    setError(null)
    setMode('report')
    setSiblings([])
    setRegenerating(false)
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Citation chips + drill-down rows open the conversation, then dismiss the modal.
  const openConversation = useCallback(
    (id: string) => {
      useConversationsStore.getState().selectConversation(id, 'recap-citation')
      close()
    },
    [close],
  )

  const refresh = useCallback(async (id: string) => {
    const doc = await fetchRecap(id)
    if (!doc) {
      setError('Recap not found or you do not have permission.')
      return
    }
    setRecap(doc)
    setError(null)
  }, [])

  // Load a sibling fork in place WITHOUT resetting the active tab -- the user
  // stays on Write-up while flipping between variants. (rclaude-recap-open, by
  // contrast, snaps back to Report; that's for external opens.)
  const loadFork = useCallback(
    (id: string) => {
      setRecapId(id)
      setRecap(null)
      setError(null)
      void refresh(id)
    },
    [refresh],
  )

  const refreshSiblings = useCallback(async (anchor: PeriodRecapDoc) => {
    const list = await fetchRecapList(anchor.projectUri)
    setSiblings(
      selectSiblings(list, {
        recapId: anchor.recapId,
        projectUri: anchor.projectUri,
        periodStart: anchor.periodStart,
        periodEnd: anchor.periodEnd,
      }),
    )
  }, [])

  const handleRegenerate = useCallback(
    (tuning: RegenerateTuning) => {
      const cur = recap
      if (!cur) return
      const ok = regenerateRecap({
        recapId: cur.recapId,
        model: tuning.model,
        instructions: tuning.instructions,
        variantLabel: tuning.variantLabel,
        temperature: tuning.temperature,
        ...(tuning.maxTokens !== undefined ? { maxTokens: tuning.maxTokens } : {}),
      })
      if (!ok) {
        toast('Not connected', 'Cannot regenerate: WebSocket is offline.', 'warning')
        return
      }
      setRegenerating(true)
      const what = tuning.variantLabel || modelLabel(tuning.model)
      toast('Generating variant', `Re-running the write-up as ${what}…`)
    },
    [recap],
  )

  useEffect(() => {
    function onOpen(detail?: { recapId?: string }) {
      if (!detail?.recapId) return
      setRecapId(detail.recapId)
      setRecap(null)
      setError(null)
      setMode('report')
      void refresh(detail.recapId)
    }
    recapOpenBus.setHandler(onOpen)
    return () => recapOpenBus.setHandler(null)
  }, [refresh])

  // Poll while still running.
  useEffect(() => {
    if (!recapId || !recap) return
    if (isTerminal(recap.status)) return
    pollRef.current = setInterval(() => {
      void refresh(recapId)
    }, POLL_MS)
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [recapId, recap, refresh])

  // Keep the fork switcher's sibling set fresh: on first load, on variant
  // switch, and whenever the recap reaches a terminal state (so a just-finished
  // fork's cost/label settle). Keyed on id+status to avoid refetch churn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshSiblings reads recap fields by value; id+status are the triggers.
  useEffect(() => {
    if (!recap) return
    void refreshSiblings(recap)
  }, [recap?.recapId, recap?.status, refreshSiblings])

  // A dashboard-triggered regenerate replied with a new fork id. If it descends
  // from the recap we're viewing, hop to it (keeping the Write-up tab) so the
  // user watches the variant generate, then render.
  useEffect(() => {
    function onForked(e: Event) {
      const detail = (e as CustomEvent).detail as { recapId?: string; sourceRecapId?: string } | undefined
      if (!detail?.recapId) return
      if (detail.sourceRecapId && detail.sourceRecapId !== recapIdRef.current) return
      setRegenerating(false)
      loadFork(detail.recapId)
    }
    window.addEventListener('rclaude-recap-forked', onForked)
    return () => window.removeEventListener('rclaude-recap-forked', onForked)
  }, [loadFork])

  return (
    <DialogPrimitive.Root open={recapId != null} onOpenChange={open => !open && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(960px,95vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover shadow-lg flex flex-col">
          <DialogPrimitive.Title className="sr-only">Recap viewer</DialogPrimitive.Title>
          {error ? (
            <div className="p-6 text-sm text-red-400">{error}</div>
          ) : !recap ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : isTerminal(recap.status) && recap.markdown ? (
            <>
              <RecapHeader recap={recap} />
              <RecapTabs mode={mode} setMode={setMode} />
              <div className="flex-1 overflow-y-auto px-4 py-3">
                {mode === 'raw' ? (
                  <pre className="text-xs whitespace-pre-wrap break-words bg-muted/30 p-3 rounded">
                    {recap.markdown}
                  </pre>
                ) : mode === 'writeup' ? (
                  <RecapWriteupTab
                    recap={recap}
                    siblings={siblings}
                    regenerating={regenerating}
                    onSelectFork={loadFork}
                    onRegenerate={handleRegenerate}
                  />
                ) : (
                  <RecapReport
                    metadata={recap.metadata}
                    digest={recap.digest}
                    markdown={recap.markdown}
                    costLedger={recap.costLedger}
                    onOpenConversation={openConversation}
                    hideWriteup
                  />
                )}
              </div>
            </>
          ) : (
            <>
              <RecapHeader recap={recap} />
              <StreamingState recap={recap} />
            </>
          )}
          <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground flex justify-end shrink-0">
            <Kbd>Esc</Kbd>
            <span className="ml-1">to close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
