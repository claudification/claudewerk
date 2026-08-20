/**
 * CLEAR -- the one control a dead row is allowed to have.
 *
 * `run-tail-row.tsx` says the section is INERT ON PURPOSE, and it stays that
 * way: no resume, no filter chip, no link, because a dimmed row that can be
 * clicked four ways is a control surface pretending to be a note. This is the
 * single exception, and it exists because O2 gave a dead run a headstone and no
 * burial -- nothing anywhere could take a finished run off an ambient pane.
 *
 * IT ACKNOWLEDGES, IT DOES NOT DELETE. The run artifact and its baton stay on
 * disk; all this writes is "a human has seen this end". The sentinel refuses it
 * on a live run, so the worst a stray click can do is nothing.
 *
 * ARMS ON THE FIRST CLICK, like every other verb on this pane -- a wall is often
 * a detached window on a second monitor, where a native confirm steals focus
 * from the main screen and blocks the surface's repaint until it is dismissed.
 */

import { useEffect, useState } from 'react'
import { clearEpicRun } from '@/lib/epic-run-api'
import { cn, haptic } from '@/lib/utils'
import { ARM_TIMEOUT_MS } from './run-actions'

export function RunClearButton({ project, epicId, onDone }: { project: string; epicId: string; onDone: () => void }) {
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
    const reply = await clearEpicRun(project, epicId)
    setBusy(false)
    // A REFUSAL IS THE INTERESTING ANSWER. The sentinel refuses a live run, and
    // a button that swallowed that would leave a row on the pane with no reason
    // -- exactly the silence this whole section was built to end.
    setNote(reply.ok ? null : reply.error || 'clear failed')
    if (reply.ok) onDone()
  }

  return (
    <>
      <button
        type="button"
        title="Acknowledge this run: it leaves the wall. The run file, its baton and every card stay on disk."
        disabled={busy}
        aria-pressed={armed}
        onClick={() => void press()}
        className={cn('wall-run-act', armed && 'wall-run-act-armed')}
      >
        {busy ? '...' : armed ? 'clear -- sure?' : 'clear'}
      </button>
      {note && <span className="wall-run-note">{note}</span>}
    </>
  )
}
