/**
 * THE CANVAS -- full-screen pan/zoom map of the whole fleet.
 *
 * Lazy-loaded from app.tsx when the hash is `#/canvas`. Conversations are
 * cards grouped into tinted PROJECT SPACES (large painted title per project);
 * sentinels hang in a top rail above their hosted work with per-profile usage.
 * Clicking a card expands it in place into a live mini-transcript (any number at once);
 * inter-conversation sends animate as pulses between cards. Live over the
 * same WS feed as the dashboard.
 */
import { ArrowLeft, Undo2 } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useWebSocket } from '@/hooks/use-websocket'
import { isEditableTarget } from '@/sheaf/sheaf-derive'
import { CanvasGraph } from './canvas-graph'
import { useCanvasData } from './use-canvas-data'
import { CanvasActionsContext, useExpanded } from './use-expanded'
import { useLayoutOverrides } from './use-layout-overrides'

function backToDashboard() {
  window.location.hash = ''
}

export function CanvasPage() {
  useWebSocket()
  const { expandedIds, toggleExpand } = useExpanded()
  const { overrides, pin, reset } = useLayoutOverrides()
  const { nodes, edges, presentIds, total, activeCount } = useCanvasData(expandedIds, overrides)
  const actions = useMemo(() => ({ toggleExpand }), [toggleExpand])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isEditableTarget(e.target)) backToDashboard()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-foreground">
        <Header total={total} activeCount={activeCount} pinnedCount={overrides.size} onResetLayout={reset} />
        <div className="min-h-0 flex-1">
          <CanvasGraph
            nodes={nodes}
            edges={edges}
            presentIds={presentIds}
            onExpandConversation={toggleExpand}
            onPinConversation={pin}
          />
        </div>
      </div>
    </CanvasActionsContext.Provider>
  )
}

interface HeaderProps {
  total: number
  activeCount: number
  pinnedCount: number
  onResetLayout: () => void
}

function fleetSummary(total: number, activeCount: number): string {
  const convs = `${total} conversation${total === 1 ? '' : 's'}`
  return activeCount > 0 ? `${convs}, ${activeCount} active` : convs
}

function ResetLayoutButton({ pinnedCount, onResetLayout }: Pick<HeaderProps, 'pinnedCount' | 'onResetLayout'>) {
  if (pinnedCount === 0) return null
  return (
    <button
      type="button"
      onClick={onResetLayout}
      title="Snap every manually-placed card back to the auto layout"
      className="flex items-center gap-1 rounded border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-foreground/5"
    >
      <Undo2 className="size-3" />
      reset layout ({pinnedCount})
    </button>
  )
}

function Header({ total, activeCount, pinnedCount, onResetLayout }: HeaderProps) {
  return (
    <div className="shrink-0 border-b border-border bg-background/95">
      <div className="flex items-center gap-4 px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={backToDashboard} className="gap-1">
          <ArrowLeft className="size-4" />
          <span className="text-xs">Back</span>
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">THE CANVAS</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">{fleetSummary(total, activeCount)}</span>
        <div className="ml-auto flex items-center gap-3">
          <ResetLayoutButton pinnedCount={pinnedCount} onResetLayout={onResetLayout} />
          <span className="hidden items-center gap-1 text-[10px] text-fg-muted md:flex">
            <Kbd>Esc</Kbd> back
          </span>
        </div>
      </div>
    </div>
  )
}
