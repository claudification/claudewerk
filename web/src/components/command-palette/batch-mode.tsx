/**
 * BATCH OPERATIONS -- pick many conversations, run one verb across all of them.
 *
 * Layout only. State, derived rows and handlers live in `use-batch-mode.ts`;
 * filtering in `batch-filter.ts`, grouping in `batch-grouping.ts`, selection in
 * `use-batch-selection.ts`, and the visual bands in `batch-filters.tsx`,
 * `batch-selection-bar.tsx`, `batch-table.tsx` and `batch-footer.tsx`.
 */

import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { BatchFilters } from './batch-filters'
import { BatchFooter } from './batch-footer'
import { BatchProgress } from './batch-progress'
import { BatchSelectionBar } from './batch-selection-bar'
import { BatchTable } from './batch-table'
import { SELECT_ALL_CAP, useBatchMode } from './use-batch-mode'

export function BatchModeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const b = useBatchMode(open, onClose)

  if (!b.isAdmin) return null

  return (
    <Dialog open={open} onOpenChange={next => !next && b.close()}>
      <DialogContent className="max-w-5xl max-h-[80vh] flex flex-col p-0 gap-0 top-[10vh] translate-y-0">
        <div className="flex items-center gap-3 border-b border-border px-3 py-2">
          <DialogTitle className="text-sm font-bold text-accent shrink-0">Batch operations</DialogTitle>
          {b.currentBatchId && (
            <span className="text-[10px] font-mono text-muted-foreground/50 truncate">{b.currentBatchId}</span>
          )}
          <span className="ml-auto mr-6 text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
            {b.selectedIds.length} selected
          </span>
        </div>

        {b.runningBatch ? (
          <BatchProgress
            action={b.runningBatch.action}
            conversationIds={b.runningBatch.ids}
            batchId={b.runningBatch.batchId}
            input={b.runningBatch.input}
            onRetry={b.retry}
            onClose={b.close}
          />
        ) : (
          <>
            <BatchFilters filter={b.filter} onChange={b.patchFilter} />
            <BatchSelectionBar
              matches={b.matches}
              visibleSelected={b.visibleSelected}
              cap={SELECT_ALL_CAP}
              groupByProject={b.groupByProject}
              onGroupByProject={b.setGroupByProject}
              selectedOnly={b.selectedOnly}
              onSelectedOnly={b.setSelectedOnly}
              showSelectedOnly={b.selectedIds.length > 0}
              onSelectVisible={b.selection.selectVisible}
              onInvert={b.selection.invert}
              onSelectAll={b.selection.selectAll}
              onClear={b.clearBatchSelection}
            />
            <div className="flex-1 min-h-0 overflow-y-auto">
              <BatchTable
                rows={b.flatRows}
                cols={b.cols}
                projectSettings={b.projectSettings}
                focusedIndex={b.focusedIndex}
                isSelected={b.selection.isSelected}
                groupState={b.selection.groupState}
                onToggleGroup={b.selection.toggleGroup}
                onActivate={b.selection.toggleAt}
                onFocusRow={b.setFocusedIndex}
              />
            </div>
            <BatchFooter
              action={b.action}
              onActionChange={b.setActionId}
              selectedCount={b.selectedIds.length}
              hiddenSelected={b.selectedIds.length - b.visibleSelected}
              canRun={b.canRun}
              broadcast={b.broadcast}
              onBroadcastChange={b.setBroadcast}
              reassign={b.reassign}
              onReassignChange={b.patchReassign}
              sentinels={b.sentinels}
              onCancel={b.close}
              onRun={b.run}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
