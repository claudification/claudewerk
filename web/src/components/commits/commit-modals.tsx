/**
 * The two commit surfaces as MANAGED modals -- parkable, maximizable,
 * detachable, state surviving every transition (detachable-surfaces covenant).
 * Parking the browser while you go read the conversation it pointed you at is
 * the whole workflow, so neither of these is a blocking dialog.
 */

import { GitCommitHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCommitModalStore } from '@/hooks/use-commit-modals'
import { type ManagedModal, useManagedModal } from '@/hooks/use-modal-manager'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { ModalWindowControls } from '../ui/modal-window-controls'
import { CommitBrowserBody } from './commit-browser-body'
import { CommitDetailBody } from './commit-detail-body'

function surfaceClass(maximized: boolean): string {
  return cn(
    'p-0',
    maximized
      ? 'left-0 top-0 h-screen w-screen max-w-none max-h-screen translate-x-0 translate-y-0 rounded-none'
      : 'top-[8vh] translate-y-0 max-h-[84vh] sm:max-w-3xl',
  )
}

/** Shared shell: chrome + sizing, so the two surfaces can't drift apart. */
function CommitSurface({
  modal,
  title,
  subtitle,
  children,
}: {
  modal: ManagedModal
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <Dialog open={modal.presentation === 'inline'} onOpenChange={o => o || modal.close()}>
      <DialogContent className={surfaceClass(modal.maximized)}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <GitCommitHorizontal className="size-4 text-emerald-400" />
          <DialogTitle className="text-xs">{title}</DialogTitle>
          {subtitle && <span className="text-[10px] font-mono text-muted-foreground truncate">{subtitle}</span>}
          <ModalWindowControls
            maximized={modal.maximized}
            onToggleMaximize={modal.toggleMaximize}
            onMinimize={modal.minimize}
          />
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}

export function CommitBrowserModal() {
  const modal = useManagedModal({ id: 'commit-browser', kind: 'commit-browser', title: 'Commits' })
  const projectFilter = useCommitModalStore(s => s.projectFilter)

  return (
    <CommitSurface modal={modal} title="Commits" subtitle={projectFilter ?? 'all projects'}>
      <div className="flex-1 min-h-0 flex flex-col">
        <CommitBrowserBody projectFilter={projectFilter ?? undefined} />
      </div>
    </CommitSurface>
  )
}

export function CommitDetailModal() {
  const modal = useManagedModal({ id: 'commit-detail', kind: 'commit-detail', title: 'Commit' })
  const hash = useCommitModalStore(s => s.hash)
  if (!hash) return null

  return (
    <CommitSurface modal={modal} title="Commit" subtitle={hash.slice(0, 12)}>
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <CommitDetailBody hash={hash} />
      </div>
    </CommitSurface>
  )
}
