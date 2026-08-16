/**
 * Batch mode's state, assembled from the pieces around it: the store slice,
 * the derived rows (`use-batch-rows`), the selection model
 * (`use-batch-selection`), the keyboard layer (`use-batch-keys`), the action
 * form (`use-batch-form`) and the run itself (`use-batch-runner`). The
 * component that consumes this is pure layout.
 */

import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import { selectConversations } from '@/lib/slim-conversation'
import type { FilterState } from './batch-filter'
import { buildRunInput } from './batch-run-input'
import { useBatchForm } from './use-batch-form'
import { useBatchKeys } from './use-batch-keys'
import { useBatchRows } from './use-batch-rows'
import { useBatchRunner } from './use-batch-runner'
import { useBatchSelection } from './use-batch-selection'

export const SELECT_ALL_CAP = 50
const NO_FILTER: FilterState = { project: '', status: 'any', sentinel: '', text: '' }

function useBatchStore() {
  const state = useConversationsStore(
    useShallow(s => ({
      conversations: selectConversations(s.conversationsById),
      projectSettings: s.projectSettings,
      selectedForBatch: s.selectedForBatch,
      currentBatchId: s.currentBatchId,
      sentinels: s.sentinels,
      isAdmin: s.permissions.canAdmin,
    })),
  )
  const actions = useConversationsStore(
    useShallow(s => ({
      selectBatch: s.selectBatch,
      clearBatchSelection: s.clearBatchSelection,
      startBatch: s.startBatch,
      toggleBatchSelection: s.toggleBatchSelection,
    })),
  )
  return { ...state, ...actions }
}

/** A batch id is minted once per opening so every action in the session shares it. */
function useBatchId(open: boolean, currentBatchId: string | null, startBatch: () => string) {
  useEffect(() => {
    if (open && !currentBatchId) startBatch()
  }, [open, currentBatchId, startBatch])
}

export function useBatchMode(open: boolean, onClose: () => void) {
  const store = useBatchStore()
  const { conversations, projectSettings, selectedForBatch, currentBatchId, startBatch } = store

  const [filter, setFilter] = useState<FilterState>(NO_FILTER)
  const [groupByProject, setGroupByProject] = useState(true)
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const patchFilter = useCallback((patch: Partial<FilterState>) => setFilter(prev => ({ ...prev, ...patch })), [])

  useBatchId(open, currentBatchId, startBatch)

  const form = useBatchForm()
  const runner = useBatchRunner(onClose)

  const rows = useBatchRows({
    conversations,
    filter,
    projectSettings,
    groupByProject,
    selectedOnly,
    selected: selectedForBatch,
  })

  const selection = useBatchSelection({
    flatRows: rows.flatRows,
    convRows: rows.convRows,
    selected: selectedForBatch,
    selectBatch: store.selectBatch,
    toggleOne: store.toggleBatchSelection,
    cap: SELECT_ALL_CAP,
  })

  useBatchKeys({
    enabled: open && !runner.runningBatch,
    rowCount: rows.flatRows.length,
    focusableIndices: rows.focusableIndices,
    focusedIndex,
    setFocusedIndex,
    selection,
  })

  const selectedIds = Array.from(selectedForBatch)
  const visibleSelected = rows.convRows.filter(r => selectedForBatch.has(r.conv.id)).length

  const run = useCallback(() => {
    runner.start({
      batchId: currentBatchId ?? startBatch(),
      action: form.action,
      ids: Array.from(selectedForBatch),
      input: buildRunInput(form.action, form.broadcast, form.reassign),
    })
  }, [runner.start, currentBatchId, startBatch, form.action, form.broadcast, form.reassign, selectedForBatch])

  return {
    ...store,
    ...form,
    ...runner,
    filter,
    patchFilter,
    groupByProject,
    setGroupByProject,
    selectedOnly,
    setSelectedOnly,
    focusedIndex,
    setFocusedIndex,
    flatRows: rows.flatRows,
    cols: rows.cols,
    matches: rows.convRows.length,
    selectedIds,
    visibleSelected,
    selection,
    canRun: selectedIds.length > 0 && !runner.runningBatch && form.isValid,
    run,
  }
}
