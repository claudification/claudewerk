/**
 * SOTU viewer tab bar + body -- pure presentation. Owns which tab renders (routes
 * to ProjectView / UniverseView); all state + wiring lives in the container.
 */

import { Globe, Layers } from 'lucide-react'
import { ProjectView } from './sotu-viewer-sections'
import type { FleetProject, SotuViewData, Tab } from './sotu-viewer-types'
import { UniverseView } from './sotu-viewer-universe'

interface SotuViewerBodyProps {
  tab: Tab
  setTab: (t: Tab) => void
  projectView: SotuViewData | null
  fleetProjects: FleetProject[] | null
  error: string | null
  onSelectProject: (projectUri: string) => void
}

function tabCls(active: boolean): string {
  const base = 'px-3 py-2 text-xs font-medium border-b-2 transition-colors'
  return `${base} ${active ? 'border-accent text-foreground' : 'border-transparent text-comment hover:text-foreground/70'}`
}

export function SotuViewerBody({
  tab,
  setTab,
  projectView,
  fleetProjects,
  error,
  onSelectProject,
}: SotuViewerBodyProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex border-b border-border/50 px-4">
        <button type="button" className={tabCls(tab === 'project')} onClick={() => setTab('project')}>
          <Layers className="size-3 inline mr-1" />
          Project
        </button>
        <button type="button" className={tabCls(tab === 'universe')} onClick={() => setTab('universe')}>
          <Globe className="size-3 inline mr-1" />
          Universe
        </button>
      </div>
      {tab === 'project' ? (
        <ProjectView view={projectView} error={error} />
      ) : (
        <UniverseView projects={fleetProjects} error={error} onSelect={onSelectProject} />
      )}
    </div>
  )
}
