/**
 * The SCHEDULED TASKS modal -- one parkable, maximizable surface listing every
 * schedule across every project, with per-schedule history and controls.
 *
 * Global rather than project-scoped on purpose: the question this answers is
 * "what is going to run without me, anywhere?", which a per-project modal
 * cannot. Opening it from a project just pre-filters the list.
 *
 * DETACHABLE SURFACES: registered via `useManagedModal`, so minimize / maximize /
 * detach and state-across-transitions come for free. This file is only the
 * surface -- the two views live in `browse-pane.tsx` and `editor-pane.tsx`.
 */

import { CalendarClock } from 'lucide-react'
import { useEffect } from 'react'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { ModalWindowControls } from '../ui/modal-window-controls'
import { BrowsePane } from './browse-pane'
import { EditorPane } from './editor-pane'
import { useScheduledTasksModalStore } from './modal-state'
import { useScheduledTasksStore } from './store'

export function ScheduledTasksModal() {
  const modal = useManagedModal({ id: 'scheduled-tasks', kind: 'scheduled-tasks', title: 'Scheduled Tasks' })
  const mode = useScheduledTasksModalStore(s => s.mode)
  const setMode = useScheduledTasksModalStore(s => s.setMode)
  const load = useScheduledTasksStore(s => s.load)
  const loaded = useScheduledTasksStore(s => s.loaded)

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const editing = mode === 'edit' || mode === 'create'

  return (
    <Dialog open={modal.presentation === 'inline'} onOpenChange={o => o || modal.close()}>
      <DialogContent
        className={cn(
          'p-0',
          modal.maximized
            ? 'left-0 top-0 h-screen w-screen max-w-none max-h-screen translate-x-0 translate-y-0 rounded-none'
            : 'top-[8vh] translate-y-0 max-h-[84vh] max-w-3xl',
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <CalendarClock className="size-4 text-primary" />
          <DialogTitle className="text-xs">Scheduled Tasks</DialogTitle>
          {editing && (
            <span className="text-[10px] text-muted-foreground">{mode === 'create' ? 'new' : 'editing'}</span>
          )}
          <div className="flex-1" />
          <ModalWindowControls
            maximized={modal.maximized}
            onToggleMaximize={modal.toggleMaximize}
            onMinimize={modal.minimize}
          />
        </div>

        <div className="flex-1 min-h-0 flex flex-col p-3">
          {editing ? (
            <EditorPane onDone={() => setMode('browse')} />
          ) : (
            <BrowsePane onCreate={() => setMode('create')} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
