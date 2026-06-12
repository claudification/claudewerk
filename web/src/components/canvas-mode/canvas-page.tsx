/**
 * THE CANVAS -- full-screen pan/zoom map of the whole fleet.
 *
 * Lazy-loaded from app.tsx when the hash is `#/canvas`. Conversations are
 * cards grouped into tinted PROJECT SPACES (large painted title per project);
 * sentinels stand in a column to the left with per-profile usage. Clicking a
 * card expands it in place into a live mini-transcript (any number at once);
 * inter-conversation sends animate as pulses between cards. Live over the
 * same WS feed as the dashboard.
 */
import { ArrowLeft } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useWebSocket } from '@/hooks/use-websocket'
import { isEditableTarget } from '@/sheaf/sheaf-derive'
import { CanvasGraph } from './canvas-graph'
import { useCanvasData } from './use-canvas-data'
import { CanvasActionsContext, useExpanded } from './use-expanded'

function backToDashboard() {
  window.location.hash = ''
}

export function CanvasPage() {
  useWebSocket()
  const [showEnded, setShowEnded] = useState(false)
  const { expandedIds, toggleExpand } = useExpanded()
  const { nodes, edges, presentIds, total, activeCount } = useCanvasData(showEnded, expandedIds)
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
        <Header
          total={total}
          activeCount={activeCount}
          showEnded={showEnded}
          onToggleEnded={() => setShowEnded(v => !v)}
        />
        <div className="min-h-0 flex-1">
          <CanvasGraph
            nodes={nodes}
            edges={edges}
            presentIds={presentIds}
            showEnded={showEnded}
            onExpandConversation={toggleExpand}
          />
        </div>
      </div>
    </CanvasActionsContext.Provider>
  )
}

interface HeaderProps {
  total: number
  activeCount: number
  showEnded: boolean
  onToggleEnded: () => void
}

function fleetSummary(total: number, activeCount: number): string {
  const convs = `${total} conversation${total === 1 ? '' : 's'}`
  return activeCount > 0 ? `${convs}, ${activeCount} active` : convs
}

function EndedToggle({ showEnded, onToggleEnded }: Pick<HeaderProps, 'showEnded' | 'onToggleEnded'>) {
  const tone = showEnded ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5'
  return (
    <button
      type="button"
      onClick={onToggleEnded}
      className={`rounded border border-border px-2.5 py-1 font-mono text-xs transition-colors ${tone}`}
    >
      ended {showEnded ? 'shown' : 'hidden'}
    </button>
  )
}

function Header({ total, activeCount, showEnded, onToggleEnded }: HeaderProps) {
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
          <EndedToggle showEnded={showEnded} onToggleEnded={onToggleEnded} />
          <span className="hidden items-center gap-1 text-[10px] text-muted-foreground/70 md:flex">
            <Kbd>Esc</Kbd> back
          </span>
        </div>
      </div>
    </div>
  )
}
