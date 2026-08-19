import { useEffect, useRef } from 'react'
import { PanelBoundary } from '@/components/panel-boundary'
import { ProjectList } from '@/components/project-list'
import { RecapJobsWidget } from '@/components/recap-jobs/recap-jobs-widget'
import { useConversationsStore } from '@/hooks/use-conversations'
import { cn } from '@/lib/utils'
import type { SidebarState } from './sidebar-open-state'
import { SidebarTools } from './sidebar-tools'
import { useSidebarScroll } from './use-sidebar-scroll'

/**
 * ONE sidebar, for phone and desktop alike. The hamburger is the only difference
 * the user ever sees.
 *
 * THE RULE THAT MAKES IT WORK: this node is mounted once and never unmounted,
 * and it is never `display:none`. Hidden means off-canvas via `transform`
 * (overlay) or clipped by a zero-width parent (docked) -- both keep it fully
 * laid out, so its scroll position, its rendered rows, and the heights
 * `contain-intrinsic-size: auto` has memorised all survive. `display:none` would
 * reset scrollTop, and unmounting -- which is what the old Radix Sheet did on
 * every close -- threw away all three. That is the entire bug.
 *
 * The `lg:` variants here must stay in lockstep with `LAYOUT_BREAKPOINT`.
 */
export function Sidebar({ state }: { state: SidebarState }) {
  const { open, overlay, toggle, close } = state
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)

  useSidebarScroll(scrollRef, open)

  // Picking a conversation dismisses the overlay -- you asked for that view, so
  // get out of the way. The docked sidebar stays put; there is nothing to dismiss.
  useEffect(() => {
    if (overlay && selectedConversationId) close()
  }, [overlay, selectedConversationId, close])

  useEffect(() => {
    if (!overlay || !open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay, open, close])

  return (
    <>
      {overlay && (
        // Scrim. Rendered only in overlay mode so the docked sidebar never pays
        // for a full-screen element; faded rather than unmounted so the dismiss
        // animation has something to fade out.
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="sidebar-scrim"
          onClick={close}
          className={cn(
            'fixed inset-0 z-40 bg-black/50 transition-opacity duration-200 lg:hidden',
            open ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />
      )}

      <aside
        // `inert` covers both presentations: an off-canvas overlay and a
        // collapsed-to-zero dock are both unreachable, so neither should hold
        // focus or answer a tap.
        inert={!open}
        aria-label="Conversations"
        className={cn(
          // STEPPED DOWN A RUNG, not level with the page.
          // This was `bg-background` -- the same fill as the transcript beside
          // it -- separated by a 16px margin and nothing else. Measured off a
          // screenshot: rail and transcript were ΔL 0.036 apart, under the
          // 0.045 floor, and a pixel scan across the seam found no divider at
          // all. The eye was inferring the boundary purely from where the cards
          // stopped. The rail recedes now (ΔL 0.05) and the seam is a real
          // line instead of a gap.
          'bg-surface-sunken flex shrink-0 flex-col',
          // Overlay (below lg): off-canvas on a transform. NOT display:none.
          'fixed inset-y-0 left-0 z-50 border-r border-border-strong shadow-lg',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-x-0' : '-translate-x-full',
          // Docked (lg and up): back into flow, collapse by clipping width so the
          // panel inside keeps its size and its scroll offset.
          'lg:static lg:z-auto lg:translate-x-0 lg:overflow-hidden lg:shadow-none',
          'lg:transition-[width,margin] lg:duration-200',
          open ? 'lg:w-[350px] lg:mr-0 lg:border-r' : 'lg:w-0 lg:mr-0 lg:border-0',
        )}
      >
        {/* Fixed inner width: the collapse animation clips this panel rather than
            reflowing it, so nothing inside relayouts on the way in or out. */}
        <div className="flex h-full w-[min(85vw,360px)] flex-col lg:w-[350px]">
          <SidebarTools canLocate={!!selectedConversationId} onCollapse={toggle} />
          {/* O5: cards run FULL-BLEED to the rail edge. The horizontal p-2 made
              every card a floating tile with a stripe of rail either side, so
              the column read as a pile of objects rather than one list. Vertical
              padding stays -- that is breathing room, not an inset. */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-0 pt-0 pb-2" data-perf-region="sidebar">
            <PanelBoundary name="Conversation list">
              <ProjectList />
            </PanelBoundary>
          </div>
          <RecapJobsWidget />
        </div>
      </aside>
    </>
  )
}
