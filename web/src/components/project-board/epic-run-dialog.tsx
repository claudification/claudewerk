/**
 * The RUN dialog: four choices, then the engine has the epic.
 *
 * BLOCKING by the frozen taxonomy -- it is a launcher, so it is not a managed
 * detachable surface.
 *
 * The concurrency field carries a warning past 5 rather than a cap. The
 * supervision ceiling is a property of REVIEW, not of the machine: everyone who
 * runs more than a handful got there by giving up per-change review, and the
 * board's job is to make that ceiling visible rather than to help exceed it.
 */

import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { type EpicRunState, type StartEpicOptions, startEpicRun } from '@/lib/epic-run-api'
import { ResumeNotice, RunDialogFooter } from './epic-run-dialog-parts'
import { CadenceChoice, ConcurrencyField, TargetChoice } from './epic-run-fields'

export function EpicRunDialog({
  epicId,
  project,
  existing,
  onClose,
  onStarted,
}: {
  epicId: string
  project: string | null
  existing: EpicRunState | null
  onClose: () => void
  onStarted: () => void
}) {
  const [cadence, setCadence] = useState<StartEpicOptions['cadence']>(existing?.cadence ?? 'now')
  const [target, setTarget] = useState<StartEpicOptions['target']>(existing?.target ?? 'merged')
  const [concurrency, setConcurrency] = useState(existing?.concurrency ?? 3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resuming = existing !== null && existing.gen > 0

  async function submit() {
    if (!project) return
    setBusy(true)
    setError(null)
    const reply = await startEpicRun(project, epicId, { cadence, target, concurrency })
    setBusy(false)
    if (!reply.ok) {
      setError(reply.error ?? 'failed to start the run')
      return
    }
    onStarted()
    onClose()
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="p-0 max-w-md">
        <div className="px-5 pt-5 pb-3 border-b border-border/50">
          <DialogTitle className="font-mono text-sm">
            {resuming ? 'RESUME' : 'RUN'} <span className="text-[color:var(--epic-solid)]">{epicId}</span>
          </DialogTitle>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          {resuming && <ResumeNotice gen={existing?.gen ?? 0} />}

          <CadenceChoice value={cadence} onChange={setCadence} />
          <TargetChoice value={target} onChange={setTarget} />
          <ConcurrencyField value={concurrency} onChange={setConcurrency} />

          {error && <span className="text-[11px] text-destructive font-mono">{error}</span>}
        </div>

        <RunDialogFooter
          busy={busy}
          disabled={!project}
          confirmLabel={resuming ? 'resume' : 'run'}
          onCancel={onClose}
          onConfirm={submit}
        />
      </DialogContent>
    </Dialog>
  )
}
