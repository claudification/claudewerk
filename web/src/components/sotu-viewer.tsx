/**
 * SOTU Viewer -- parkable modal, two tabs: PROJECT (current project's chronicle)
 * and UNIVERSE (fleet rollup). Live refresh off sotu_updated/sotu_contribution is
 * debounced + project-filtered + swap-in-place, so an event storm never strobes
 * the view back to "Loading..." (the old Universe-tab hang).
 */

import { Globe } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { useCommand } from '@/lib/commands'
import { ModalSurface } from './modal-surface'
import { SotuViewerBody } from './sotu-viewer-tabs'
import type { FleetProject, SotuViewData, Tab } from './sotu-viewer-types'

// fallow-ignore-next-line complexity
export function SotuViewerModal() {
  const modal = useManagedModal({ id: 'sotu-viewer', kind: 'sotu-viewer', title: 'State of the Union' })
  const [tab, setTab] = useState<Tab>('project')
  const [projectView, setProjectView] = useState<SotuViewData | null>(null)
  const [fleetProjects, setFleetProjects] = useState<FleetProject[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const refreshRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const conversations = useConversationsStore(s => s.conversationsById)
  const currentProject = selectedConversationId ? conversations?.[selectedConversationId]?.project : undefined
  // ManagedModal has `presentation`, NOT `isVisible`. The old code read
  // `modal.isVisible` (always undefined) so the fetch-on-open effect always
  // early-returned -- the viewer only loaded off incidental live events, hence
  // Universe hanging on "Loading..." when opened on a lull.
  const isVisible = modal.presentation !== 'closed'

  const startTimeout = useCallback(() => {
    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(
      () => setError('No response from broker -- is it deployed with SOTU WS handlers?'),
      5000,
    )
  }, [])

  const clearError = useCallback(() => {
    clearTimeout(timeoutRef.current)
    setError(null)
  }, [])

  // `blank=true`: user-initiated (open / tab switch) -- show spinner + arm the
  // no-response timeout. `blank=false`: background refresh off a live event --
  // swap in place, never blank, never re-arm, so an event burst can't strobe
  // the view or leave it stuck on "Loading...".
  const fetchProject = useCallback(
    (blank = true) => {
      if (!currentProject) return
      if (blank) {
        setError(null)
        setProjectView(null)
        startTimeout()
      }
      wsSend('sotu_view', { project: currentProject })
    },
    [currentProject, startTimeout],
  )

  const fetchFleet = useCallback(
    (blank = true) => {
      if (blank) {
        setError(null)
        setFleetProjects(null)
        startTimeout()
      }
      wsSend('sotu_fleet')
    },
    [startTimeout],
  )

  useEffect(() => {
    if (!isVisible) return
    if (tab === 'project') fetchProject()
    else fetchFleet()
  }, [isVisible, tab, fetchProject, fetchFleet])

  useEffect(() => {
    if (!isVisible) return
    // Coalesce a burst of live events into ONE silent refresh -- the broker fires
    // sotu_contribution/sotu_updated on every turn-digest + distill across the
    // fleet; without this the Universe tab refetched (+ blanked) on each and
    // never settled.
    function scheduleRefresh() {
      clearTimeout(refreshRef.current)
      refreshRef.current = setTimeout(() => {
        if (tab === 'project') fetchProject(false)
        else fetchFleet(false)
      }, 600)
    }
    // fallow-ignore-next-line complexity
    function onSotuWs(e: CustomEvent<{ type: string; [k: string]: unknown }>) {
      const { type, view, projects, project, error: err } = e.detail as Record<string, unknown>
      if (type === 'sotu_view_result') {
        clearError()
        if (err) setError(err as string)
        else if (view) setProjectView(view as SotuViewData)
      } else if (type === 'sotu_fleet_result') {
        clearError()
        if (projects) setFleetProjects(projects as FleetProject[])
      } else if (type === 'sotu_updated' || type === 'sotu_contribution') {
        // Project tab only cares about ITS project; Universe cares about any.
        if (tab === 'project' && project && project !== currentProject) return
        scheduleRefresh()
      }
    }
    window.addEventListener('sotu-ws' as string, onSotuWs as EventListener)
    return () => {
      window.removeEventListener('sotu-ws' as string, onSotuWs as EventListener)
      clearTimeout(refreshRef.current)
    }
  }, [isVisible, tab, currentProject, fetchProject, fetchFleet, clearError])

  useCommand('sotu-viewer', () => modal.open({ type: 'global' }), { label: 'State of the Union', group: 'View' })

  return (
    <ModalSurface
      modal={modal}
      title="State of the Union"
      icon={<Globe className="size-4 text-accent" />}
      className="max-w-2xl top-[8vh] translate-y-0 max-h-[84vh]"
    >
      <SotuViewerBody tab={tab} setTab={setTab} projectView={projectView} fleetProjects={fleetProjects} error={error} />
    </ModalSurface>
  )
}
