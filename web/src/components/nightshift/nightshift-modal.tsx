/**
 * The NIGHTSHIFT modal -- one parkable, maximizable, project-scoped surface with
 * three tabs spanning a night's lifecycle: Outlook (the queued plan) / Status
 * (live night-ops) / Report (morning results). Opened from the project context
 * menu and the project action panel via openNightshiftModal(). Replaces the old
 * #/nightshift + #/nightshift-status fullscreen routes.
 */

import { Moon } from 'lucide-react'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { type NightshiftTab, useNightshiftModalStore } from '@/hooks/use-nightshift-modal'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { ModalWindowControls } from '../ui/modal-window-controls'
import { NightshiftOutlook } from './nightshift-outlook'
import { NightshiftReportBody } from './nightshift-report-body'
import { NightshiftStatusBody } from './nightshift-status-body'

const TABS: { id: NightshiftTab; label: string }[] = [
  { id: 'outlook', label: 'Outlook' },
  { id: 'status', label: 'Status' },
  { id: 'report', label: 'Report' },
]

function projectTail(uri: string): string {
  return uri.replace(/\/+$/, '').split('/').pop() || uri
}

function ModalHeader({
  projectUri,
  tab,
  setTab,
  maximized,
  onToggleMax,
  onMinimize,
}: {
  projectUri: string
  tab: NightshiftTab
  setTab: (t: NightshiftTab) => void
  maximized: boolean
  onToggleMax: () => void
  onMinimize: () => void
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
      <Moon className="size-4 text-amber-400" />
      <DialogTitle className="text-xs">Nightshift</DialogTitle>
      <span className="text-[10px] text-muted-foreground truncate">{projectTail(projectUri)}</span>

      <div className="ml-3 flex items-center gap-0.5">
        {TABS.map(t => (
          <button
            type="button"
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'text-[11px] px-2 py-0.5 rounded transition-colors',
              tab === t.id ? 'bg-amber-500/15 text-amber-300' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ModalWindowControls maximized={maximized} onToggleMaximize={onToggleMax} onMinimize={onMinimize} />
    </div>
  )
}

function ModalBody({ tab, projectUri }: { tab: NightshiftTab; projectUri: string }) {
  if (tab === 'status') return <NightshiftStatusBody projectUri={projectUri} />
  if (tab === 'report') return <NightshiftReportBody projectUri={projectUri} />
  return <NightshiftOutlook projectUri={projectUri} />
}

function scopeProjectUri(scope: ReturnType<typeof useManagedModal>['scope']): string | undefined {
  return scope?.type === 'project' ? scope.uri : undefined
}

export function NightshiftModal() {
  const modal = useManagedModal({ id: 'nightshift', kind: 'nightshift', title: 'Nightshift' })
  const tab = useNightshiftModalStore(s => s.tab)
  const setTab = useNightshiftModalStore(s => s.setTab)

  const projectUri = scopeProjectUri(modal.scope)
  if (!projectUri) return null

  return (
    <Dialog open={modal.presentation === 'inline'} onOpenChange={o => o || modal.close()}>
      <DialogContent
        className={cn(
          'p-0',
          modal.maximized
            ? 'left-0 top-0 h-screen w-screen max-w-none max-h-screen translate-x-0 translate-y-0 rounded-none'
            : 'top-[8vh] translate-y-0 max-h-[84vh]',
        )}
      >
        <ModalHeader
          projectUri={projectUri}
          tab={tab}
          setTab={setTab}
          maximized={modal.maximized}
          onToggleMax={modal.toggleMaximize}
          onMinimize={modal.minimize}
        />
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <ModalBody tab={tab} projectUri={projectUri} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
