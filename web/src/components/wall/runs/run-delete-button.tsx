/**
 * DELETE -- the second and last control the dimmed tail is allowed to have.
 *
 * `clear` says "this happened and I have seen it". This says "this should not be
 * in the record at all" -- a run armed by mistake, a duplicate, a scratch run
 * nobody wants in the history. Those are different questions, which is the only
 * reason there are two buttons here rather than one.
 *
 * IT IS A MOVE, NOT AN `rm`. The sentinel relocates the run's tree to
 * `.deleted/<id>-<ts>/`, so a mistaken delete is one `mv` from being undone. The
 * broker refuses it while any conversation tagged with this epic is still live,
 * which is stricter than `clear` and deliberately so: this one moves the file
 * those seats are writing to.
 *
 * VISUALLY DISTINCT FROM `clear`, because it sits directly beside it and the two
 * are not interchangeable -- a click that lands one button over must not read as
 * the same gesture. Same arm-then-confirm as everything else on this pane (a
 * wall is often a detached window where a native confirm steals focus), with the
 * armed label carrying the one fact a human will otherwise get wrong: the CARDS
 * survive.
 */

import { useEffect, useState } from 'react'
import { deleteEpicRun } from '@/lib/epic-inspect-api'
import { cn, haptic } from '@/lib/utils'
import { ARM_TIMEOUT_MS } from './run-actions'

const TITLE =
  'Remove this run from the record. The run file and its baton are MOVED to ' +
  '.rclaude/project/epics/.deleted/, not destroyed. Its CARDS are NOT deleted. ' +
  'Refused while the run is armed or running, or while any of its conversations is still live.'

export function RunDeleteButton({ project, epicId, onDone }: { project: string; epicId: string; onDone: () => void }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [armed])

  async function press(): Promise<void> {
    if (!armed) {
      setArmed(true)
      setNote(null)
      return
    }
    setArmed(false)
    haptic('tap')
    setBusy(true)
    const reply = await deleteEpicRun(project, epicId, 'deleted from the wall')
    setBusy(false)
    // A REFUSAL IS THE INTERESTING ANSWER, exactly as it is for `clear`: the two
    // refusals here name a live seat or a live run, and a button that swallowed
    // them would leave the row on the pane with no reason given.
    setNote(reply.ok ? null : reply.error || 'delete failed')
    if (reply.ok) onDone()
  }

  return (
    <>
      <button
        type="button"
        title={TITLE}
        disabled={busy}
        aria-pressed={armed}
        onClick={() => void press()}
        className={cn('wall-run-act wall-run-act-danger', armed && 'wall-run-act-danger-armed')}
      >
        {busy ? '...' : armed ? 'delete run, keep cards -- sure?' : 'delete'}
      </button>
      {note && <span className="wall-run-note">{note}</span>}
    </>
  )
}
