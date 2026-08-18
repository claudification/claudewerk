/**
 * The RUN dialog: what you are handing over, then the choices that shape it.
 *
 * BLOCKING by the frozen taxonomy -- it is a launcher, so it is not a managed
 * detachable surface.
 *
 * It used to be three settings and nothing else: you armed an unattended fleet
 * knowing the epic's id and not whether that meant two cards or forty. The
 * briefing is derived from the rollup the RUN button was already holding, so
 * describing the work costs nothing.
 *
 * The concurrency field carries a warning past 5 rather than a cap. The
 * supervision ceiling is a property of REVIEW, not of the machine: everyone who
 * runs more than a handful got there by giving up per-change review, and the
 * board's job is to make that ceiling visible rather than to help exceed it.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import { useMemo, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import { type EpicRunState, startEpicRun } from '@/lib/epic-run-api'
import { RunBriefing, RunConsequence } from './epic-run-briefing'
import { ResumeNotice, RunDialogFooter, RunDialogHeader } from './epic-run-dialog-parts'
import { RunSettings } from './epic-run-fields'
import { consequence, runPlan } from './epic-run-plan'
import { useRunSettings } from './use-run-settings'

export function EpicRunDialog({
  rollup,
  project,
  existing,
  onClose,
  onStarted,
}: {
  rollup: EpicRollup
  project: string | null
  existing: EpicRunState | null
  onClose: () => void
  onStarted: () => void
}) {
  const settings = useRunSettings(existing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resuming = existing !== null && existing.gen > 0
  const plan = useMemo(() => runPlan(rollup), [rollup])

  async function submit() {
    if (!project) return
    setBusy(true)
    setError(null)
    const reply = await startEpicRun(project, rollup.epicId, settings.options)
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
      {/* The dialog is portaled to document.body, OUTSIDE the pane that sets the
          epic's colour vars -- so every `var(--epic-*)` in here (the selected
          chips, the run button, the title) was resolving to nothing. It carries
          its own. */}
      <DialogContent style={epicColorVars(epicHue(rollup.epicId, rollup.card?.color))} className="p-0 max-w-md">
        <RunDialogHeader rollup={rollup} resuming={resuming} />

        <div className="px-5 py-4 flex flex-col gap-4">
          {resuming && <ResumeNotice gen={existing?.gen ?? 0} />}

          <RunBriefing plan={plan} />
          <RunSettings settings={settings} plan={plan} />
          <RunConsequence text={consequence(settings.options)} irreversible={settings.options.target === 'shipped'} />

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
