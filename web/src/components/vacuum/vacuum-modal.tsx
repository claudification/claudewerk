/**
 * The VACUUM workbench -- a parkable managed surface (DETACHABLE SURFACES).
 *
 * Parkable because an apply runs for minutes and you want to walk away from it
 * with its progress intact. The APPLY confirm nested inside is blocking, and
 * stays blocking. See vacuum-state.ts for the full reasoning.
 */

import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { useSurfaceActivity } from '@/hooks/use-surface-activity'
import { ModalSurface } from '../modal-surface'
import { ApplyConfirm } from './apply-confirm'
import { RunLog } from './run-log'
import { useVacuumEstimate } from './use-vacuum'
import { vacuumActivity } from './vacuum-activity'
import { VacuumFooter } from './vacuum-footer'
import { VacuumRows } from './vacuum-rows'
import { startVacuumRun, useVacuumRunStore, type VacuumRunMode } from './vacuum-run-store'
import { VACUUM_MODAL } from './vacuum-state'
import { DEFAULT_SELECTION, type VacuumSelection } from './vacuum-types'

function VacuumBody() {
  const [selection, setSelection] = useState<VacuumSelection>(DEFAULT_SELECTION)
  const [confirming, setConfirming] = useState(false)
  const { data, error, loading, measuringBytes, refresh, measureBytes } = useVacuumEstimate(selection.hotDays, true)
  const work = useVacuumRunStore()

  // Say what we are doing, so the dock tile can say it while we are parked.
  useSurfaceActivity(VACUUM_MODAL.id, vacuumActivity({ ...work, error: work.error ?? error, loading, measuringBytes }))

  const run = async (mode: VacuumRunMode) => {
    await startVacuumRun(mode, selection)
    refresh(selection.hotDays)
  }

  if (error) {
    return <div className="p-4 text-xs text-destructive">Vacuum unavailable: {error}</div>
  }
  if (!data) {
    return <div className="p-4 text-xs text-muted-foreground">Measuring...</div>
  }
  if (!data.configured) {
    return <div className="p-4 text-xs text-muted-foreground">This broker has no cache directory to reclaim.</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <p className="pb-2 text-[10px] leading-relaxed text-muted-foreground">
          Transcript history is archived and deleted a whole UTC month at a time -- that is the only unit the verified
          delete path supports. Ended conversations are not removed and stay revivable; only their older transcripts
          move to cold storage.
          {loading && <span className="ml-1 italic">re-measuring...</span>}
        </p>
        <VacuumRows estimate={data} selection={selection} onChange={setSelection} />
      </div>

      <RunLog steps={work.steps} />

      <VacuumFooter
        estimate={data}
        busy={work.running}
        measuringBytes={measuringBytes}
        onMeasureBytes={() => measureBytes(selection.hotDays)}
        onPlan={() => void run('plan')}
        onApply={() => setConfirming(true)}
      />

      <ApplyConfirm
        open={confirming}
        estimate={data}
        selection={selection}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void run('apply')
        }}
      />
    </div>
  )
}

export function VacuumModal() {
  const modal = useManagedModal(VACUUM_MODAL)
  if (modal.presentation === 'closed') return null

  return (
    <ModalSurface
      modal={modal}
      title="Vacuum"
      icon={<Trash2 className="size-4 text-destructive" />}
      className="max-w-2xl w-[92vw] top-[7vh] translate-y-0 h-[78vh]"
    >
      <VacuumBody />
    </ModalSurface>
  )
}
