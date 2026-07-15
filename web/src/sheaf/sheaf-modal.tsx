/**
 * Sheaf -- 24/48h fleet overview as a PARKABLE managed surface (was the `#/sheaf`
 * fullscreen hash page). Rides useManagedModal + ModalSurface, so it gets
 * minimize/maximize/detach/close + state-survives-every-transition for free.
 * Read-only admin view over `GET /api/sheaf`; fetch is gated on visibility.
 */

import type { SheafResponse } from '@shared/sheaf-types'
import { Wheat } from 'lucide-react'
import { useRef, useState } from 'react'
import { ModalSurface } from '@/components/modal-surface'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { useCommand } from '@/lib/commands'
import { SheafToolbar, SheafTotals } from './sheaf-header'
import { ProjectSection } from './sheaf-project-section'
import { EmptyState, ErrorBanner, Skeleton } from './sheaf-states'
import { useSheaf } from './use-sheaf'
import { type SheafFilters, useSheafFilters } from './use-sheaf-filters'
import { useSheafKeyboard } from './use-sheaf-keyboard'

// fallow-ignore-next-line complexity
export function SheafModal() {
  const modal = useManagedModal({ id: 'sheaf', kind: 'sheaf', title: 'Sheaf' })
  const visible = modal.presentation !== 'closed'
  const [windowH, setWindowH] = useState(24)
  const { data, loading, error, reload } = useSheaf(windowH, visible)
  const now = data?.generatedAt ?? Date.now()
  const filters = useSheafFilters(data?.projects ?? [])
  const filterRef = useRef<HTMLInputElement>(null)
  useSheafKeyboard({ filterRef, reload, active: modal.presentation === 'inline' })

  useCommand('open-sheaf', () => modal.open({ type: 'global' }), {
    label: 'Sheaf (24/48h fleet overview)',
    group: 'Navigation',
  })

  return (
    <ModalSurface
      modal={modal}
      title="SHEAF"
      icon={<Wheat className="size-4 text-accent" />}
      className="max-w-[min(1600px,95vw)] w-[95vw] top-[4vh] translate-y-0 max-h-[92vh] h-[92vh]"
    >
      <SheafToolbar
        windowH={windowH}
        onWindowH={setWindowH}
        onRefresh={reload}
        loading={loading}
        generatedAt={data?.generatedAt}
        filters={filters}
        filterRef={filterRef}
      />
      <SheafTotals data={data} windowH={windowH} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4">
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
    </ModalSurface>
  )
}

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
