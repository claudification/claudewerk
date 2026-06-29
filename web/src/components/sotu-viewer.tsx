/**
 * SOTU Viewer -- parkable modal showing per-project + universe State of the Union.
 * Two tabs: PROJECT (current project's chronicle) and UNIVERSE (fleet rollup).
 * Subscribes to sotu_updated/sotu_contribution for live refresh.
 */

import { useCallback, useEffect, useState } from 'react'
import { Globe, Layers } from 'lucide-react'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { useCommand } from '@/lib/commands'
import { ModalSurface } from './modal-surface'

interface ChronicleEntry {
  convId: string
  title?: string
  detail: string
  ts: number
}

interface SotuViewData {
  project: string
  enabled: boolean
  chronicle: {
    now: ChronicleEntry[]
    justDone: ChronicleEntry[]
    narrative: string
    generatedAt: number
  }
  holds: Array<{ kind: string; target: string; holders: Array<{ convId: string }>; contended: boolean }>
  alerts: string[]
  builtAt: number
}

interface FleetProject {
  project: string
  projectUri: string
  enabled: boolean
  queueSize: number
  view: SotuViewData
}

type Tab = 'project' | 'universe'

function ago(ms: number, now: number): string {
  if (!ms) return 'never'
  const diff = now - ms
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`
  return `${Math.round(diff / 3600_000)}h ago`
}

function NarrativeBlock({ text }: { text: string }) {
  if (!text) return <p className="text-comment text-xs italic">No narrative generated yet (SOTU may be disabled)</p>
  return <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">{text}</p>
}

function ChronicleSection({ label, entries, now }: { label: string; entries: ChronicleEntry[]; now: number }) {
  if (!entries.length) return null
  return (
    <div className="mt-4">
      <h4 className="text-[10px] uppercase tracking-widest text-comment font-semibold mb-1">{label} ({entries.length})</h4>
      <div className="space-y-1">
        {entries.map((e, i) => (
          <div key={`${e.convId}-${i}`} className="flex gap-2 text-xs">
            <span className="text-comment shrink-0">{ago(e.ts, now)}</span>
            <span className="text-foreground/80 truncate">{e.title ?? e.convId.slice(0, 8)}</span>
            <span className="text-comment truncate flex-1">{e.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function HoldsSection({ holds }: { holds: SotuViewData['holds'] }) {
  if (!holds.length) return null
  return (
    <div className="mt-4">
      <h4 className="text-[10px] uppercase tracking-widest text-comment font-semibold mb-1">Active Holds ({holds.length})</h4>
      <div className="space-y-1">
        {holds.map((h, i) => (
          <div key={`${h.target}-${i}`} className="flex items-center gap-2 text-xs">
            {h.contended && <span className="px-1 py-0.5 rounded bg-amber-500 text-amber-950 text-[9px] font-bold uppercase">contended</span>}
            <span className="font-mono text-foreground/80">{h.target}</span>
            <span className="text-comment">({h.holders.length} holder{h.holders.length > 1 ? 's' : ''})</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProjectView({ view }: { view: SotuViewData | null }) {
  if (!view) return <p className="text-comment text-xs p-4">Loading...</p>
  const now = Date.now()
  return (
    <div className="p-4 space-y-2 overflow-y-auto flex-1">
      <div className="flex items-center gap-2 mb-3">
        <span className={`h-2 w-2 rounded-full ${view.enabled ? 'bg-accent' : 'bg-comment/40'}`} />
        <span className="font-mono text-xs font-medium">{view.project}</span>
        <span className="text-[10px] text-comment ml-auto">built {ago(view.builtAt, now)}</span>
      </div>
      <NarrativeBlock text={view.chronicle.narrative} />
      <ChronicleSection label="Now" entries={view.chronicle.now} now={now} />
      <ChronicleSection label="Just Done" entries={view.chronicle.justDone} now={now} />
      <HoldsSection holds={view.holds} />
      {view.alerts.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[10px] uppercase tracking-widest text-accent font-semibold mb-1">Alerts ({view.alerts.length})</h4>
          {view.alerts.map((a, i) => (
            <span key={i} className="inline-block mr-1 mb-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-rose-500/15 text-rose-300 border border-rose-500/40">{a}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function UniverseView({ projects }: { projects: FleetProject[] | null }) {
  if (!projects) return <p className="text-comment text-xs p-4">Loading...</p>
  const enabled = projects.filter(p => p.enabled)
  const withActivity = projects.filter(p => p.queueSize > 0 || p.view.chronicle.now.length > 0)
  return (
    <div className="p-4 overflow-y-auto flex-1">
      <div className="text-xs text-comment mb-3">
        {projects.length} projects -- {enabled.length} enabled -- {withActivity.length} with activity
      </div>
      <div className="space-y-3">
        {(withActivity.length > 0 ? withActivity : projects.slice(0, 20)).map(p => (
          <div key={p.projectUri} className="rounded-lg border border-border/50 p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className={`h-1.5 w-1.5 rounded-full ${p.enabled ? 'bg-accent' : 'bg-comment/30'}`} />
              <span className="font-mono text-[11px] font-medium">{p.project}</span>
              <span className="text-[10px] text-comment ml-auto">{p.queueSize} queued</span>
            </div>
            {p.view.chronicle.narrative && (
              <p className="text-[11px] text-foreground/70 leading-relaxed line-clamp-2">{p.view.chronicle.narrative}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// fallow-ignore-next-line complexity
export function SotuViewerModal() {
  const modal = useManagedModal({ id: 'sotu-viewer', kind: 'sotu-viewer', title: 'State of the Union' })
  const [tab, setTab] = useState<Tab>('project')
  const [projectView, setProjectView] = useState<SotuViewData | null>(null)
  const [fleetProjects, setFleetProjects] = useState<FleetProject[] | null>(null)

  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const conversations = useConversationsStore(s => s.conversations)
  const currentProject = selectedConversationId ? conversations.get(selectedConversationId)?.project : undefined

  const fetchProject = useCallback(() => {
    if (currentProject) wsSend('sotu_view', { project: currentProject })
  }, [currentProject])

  const fetchFleet = useCallback(() => {
    wsSend('sotu_fleet')
  }, [])

  useEffect(() => {
    if (!modal.isVisible) return
    if (tab === 'project') fetchProject()
    else fetchFleet()
  }, [modal.isVisible, tab, fetchProject, fetchFleet])

  useEffect(() => {
    const refresh = tab === 'project' ? fetchProject : fetchFleet
    // fallow-ignore-next-line complexity
    function onSotuWs(e: CustomEvent<{ type: string; [k: string]: unknown }>) {
      const { type, view, projects } = e.detail as Record<string, unknown>
      if (type === 'sotu_view_result' && view) setProjectView(view as SotuViewData)
      else if (type === 'sotu_fleet_result' && projects) setFleetProjects(projects as FleetProject[])
      else if (type === 'sotu_updated' || type === 'sotu_contribution') refresh()
    }
    window.addEventListener('sotu-ws' as string, onSotuWs as EventListener)
    return () => window.removeEventListener('sotu-ws' as string, onSotuWs as EventListener)
  }, [tab, fetchProject, fetchFleet])

  useCommand(
    'sotu-viewer',
    () => modal.open(),
    { label: 'State of the Union', group: 'View' },
  )

  return (
    <ModalSurface
      modal={modal}
      title="State of the Union"
      icon={<Globe className="size-4 text-accent" />}
      className="max-w-2xl top-[8vh] translate-y-0 max-h-[84vh]"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex border-b border-border/50 px-4">
          <button
            type="button"
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${tab === 'project' ? 'border-accent text-foreground' : 'border-transparent text-comment hover:text-foreground/70'}`}
            onClick={() => setTab('project')}
          >
            <Layers className="size-3 inline mr-1" />
            Project
          </button>
          <button
            type="button"
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${tab === 'universe' ? 'border-accent text-foreground' : 'border-transparent text-comment hover:text-foreground/70'}`}
            onClick={() => setTab('universe')}
          >
            <Globe className="size-3 inline mr-1" />
            Universe
          </button>
        </div>
        {tab === 'project' ? <ProjectView view={projectView} /> : <UniverseView projects={fleetProjects} />}
      </div>
    </ModalSurface>
  )
}
