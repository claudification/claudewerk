/**
 * The APPLY confirm.
 *
 * BLOCKING, and it stays blocking. The taxonomy is frozen on this point: a
 * destructive confirm you can park and come back to defeats its own purpose.
 * The workbench around it is parkable precisely so this can be the one thing
 * that is not.
 *
 * It names the exact months and row counts rather than a total, because "5.7 GB"
 * is not something anyone can sanity-check and "2026-04, 2026-05, 2026-06 --
 * 824,388 rows" is.
 */

import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { eligibleMonths, eligibleTotals, formatMeasuredBytes, formatRows } from './format'
import type { VacuumEstimate, VacuumSelection } from './vacuum-types'

interface Props {
  open: boolean
  estimate: VacuumEstimate
  selection: VacuumSelection
  onCancel: () => void
  onConfirm: () => void
}

export function ApplyConfirm({ open, estimate, selection, onCancel, onConfirm }: Props) {
  const months = eligibleMonths(estimate)
  const totals = eligibleTotals(estimate)
  const files = Object.entries(selection.files).filter(([, days]) => days !== undefined)

  return (
    <Dialog open={open} onOpenChange={o => o || onCancel()}>
      <DialogContent className="max-w-md">
        <DialogTitle className="text-sm">Vacuum -- this deletes data</DialogTitle>

        <div className="space-y-3 text-xs leading-relaxed">
          {selection.transcripts && months.length > 0 && (
            <div>
              <div className="font-medium">Transcript months</div>
              <div className="text-muted-foreground">
                {months.join(', ')} -- {formatRows(totals.rows)} rows (
                {formatMeasuredBytes(totals.bytes, estimate.bytes)}). Each is exported to
                <span className="font-mono"> transcripts-YYYY-MM.ndjson.zst</span> and verified against the live
                database before a single row is removed. Conversations are not deleted; their older transcripts move to
                cold storage and come back with <span className="font-mono">broker-cli archive import</span>.
              </div>
            </div>
          )}

          {selection.indexes && estimate.redundantIndexes.length > 0 && (
            <div>
              <div className="font-medium">Indexes</div>
              <div className="text-muted-foreground">
                Drops {estimate.redundantIndexes.map(i => i.name).join(', ')}. Each duplicates another index exactly and
                is restored with one CREATE INDEX.
              </div>
            </div>
          )}

          {files.length > 0 && (
            <div>
              <div className="font-medium">Files</div>
              <div className="text-muted-foreground">
                {files.map(([key, days]) => `${key} older than ${days}d`).join(', ')}. Deleted from disk, not archived.
              </div>
            </div>
          )}

          <div className="rounded bg-muted px-2 py-1.5 text-[10px] text-muted-foreground">
            The broker will stop answering for a minute or two during the final rewrite. Progress appears in the panel
            as each step completes.
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            Delete and reclaim
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
