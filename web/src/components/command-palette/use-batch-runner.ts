/**
 * Handing a selection to a batch action and holding the run while it streams.
 * A non-null `runningBatch` is what swaps the picker for the progress view.
 */

import { useCallback, useState } from 'react'
import type { BatchAction } from './batch-actions'

export interface RunningBatch {
  batchId: string
  action: BatchAction
  ids: string[]
  input: unknown
}

export interface BatchRunner {
  runningBatch: RunningBatch | null
  start: (run: RunningBatch) => void
  /** Re-run only the conversations that failed, keeping the same batch id. */
  retry: (failedIds: string[]) => void
  /** Drop the run and hand control back to the caller's close. */
  close: () => void
}

export function useBatchRunner(onClose: () => void): BatchRunner {
  const [runningBatch, setRunningBatch] = useState<RunningBatch | null>(null)

  const retry = useCallback((failedIds: string[]) => {
    setRunningBatch(prev => (prev ? { ...prev, ids: failedIds } : prev))
  }, [])

  const close = useCallback(() => {
    setRunningBatch(null)
    onClose()
  }, [onClose])

  return { runningBatch, start: setRunningBatch, retry, close }
}
