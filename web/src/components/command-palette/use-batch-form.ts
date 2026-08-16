/**
 * Which batch action is picked and the form it wants filled in.
 */

import { useCallback, useState } from 'react'
import { ALL_BATCH_ACTIONS, type BatchAction } from './batch-actions'
import { isInputValid, type ReassignFields } from './batch-run-input'

const NO_REASSIGN: ReassignFields = { project: '', sentinel: '', profile: '' }
const FALLBACK_ACTION = ALL_BATCH_ACTIONS[0]

export interface BatchForm {
  action: BatchAction
  setActionId: (id: string) => void
  broadcast: string
  setBroadcast: (v: string) => void
  reassign: ReassignFields
  patchReassign: (patch: Partial<ReassignFields>) => void
  /** Whether the picked action's form is filled in enough to run. */
  isValid: boolean
}

export function useBatchForm(): BatchForm {
  const [actionId, setActionId] = useState<string>(FALLBACK_ACTION.id)
  const [broadcast, setBroadcast] = useState('')
  const [reassign, setReassign] = useState<ReassignFields>(NO_REASSIGN)

  const patchReassign = useCallback(
    (patch: Partial<ReassignFields>) => setReassign(prev => ({ ...prev, ...patch })),
    [],
  )

  const action = ALL_BATCH_ACTIONS.find(a => a.id === actionId) ?? FALLBACK_ACTION

  return {
    action,
    setActionId,
    broadcast,
    setBroadcast,
    reassign,
    patchReassign,
    isValid: isInputValid(action, broadcast, reassign),
  }
}
