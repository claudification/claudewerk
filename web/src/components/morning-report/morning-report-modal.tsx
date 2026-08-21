/**
 * THE MORNING REPORT -- a parkable managed surface (DETACHABLE SURFACES).
 *
 * `useManagedModal` + `<ModalSurface>` rather than a hand-rolled dialog, which
 * buys inline / docked / detached and state-across-transitions for free. The
 * dock parks it OFFSCREEN STILL MOUNTED, so a half-ticked list survives being
 * walked away from -- which is the entire user story: coffee, review, execute.
 */

import { Coffee } from 'lucide-react'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { ModalSurface } from '../modal-surface'
import { MorningReportBody } from './morning-report-body'
import { MORNING_REPORT_MODAL, morningReportScopeUri } from './morning-report-state'

export function MorningReportModal() {
  const modal = useManagedModal(MORNING_REPORT_MODAL)
  const project = morningReportScopeUri(modal.scope)
  if (modal.presentation === 'closed') return null

  return (
    <ModalSurface
      modal={modal}
      title="Morning report"
      icon={<Coffee className="size-4 text-amber-500" />}
      headerExtra={project && <span className="truncate font-mono text-[10px] text-muted-foreground">{project}</span>}
      className="max-w-2xl w-[92vw] top-[7vh] translate-y-0 h-[78vh]"
    >
      <MorningReportBody project={project} />
    </ModalSurface>
  )
}
