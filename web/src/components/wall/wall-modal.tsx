/**
 * THE WALL, as a managed surface.
 *
 * `useManagedModal` + `<ModalSurface>` per the epic's DETACHABLE SURFACES rule,
 * so inline / docked / detached and the window chrome come for free -- and
 * detaching this onto a second monitor and leaving it there IS the feature.
 *
 * `visible` is handed down because ambient mode has real side effects
 * (fullscreen, a document-level key handler) that a parked wall must not keep
 * running while it sits offscreen in the dock.
 */

import { Grid2x2 } from 'lucide-react'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { ModalSurface } from '../modal-surface'
import { WALL_MODAL } from './wall-state'
import { WallSurface } from './wall-surface'

export function WallModal() {
  const modal = useManagedModal(WALL_MODAL)
  if (modal.presentation === 'closed') return null

  return (
    <ModalSurface
      modal={modal}
      title="THE WALL"
      icon={<Grid2x2 className="size-4 text-[color:var(--info)]" />}
      className="max-w-none w-[97vw] top-[2vh] translate-y-0 h-[94vh]"
    >
      <WallSurface visible={modal.presentation !== 'docked'} />
    </ModalSurface>
  )
}
