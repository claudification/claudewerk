/**
 * CLEAR -- the first of the two controls a dead row is allowed to have.
 *
 * `run-tail-row.tsx` says the section is INERT ON PURPOSE, and it stays that
 * way apart from these two: no resume, no filter chip, no link, because a dimmed
 * row that can be clicked four ways is a control surface pretending to be a
 * note. This one exists because O2 gave a dead run a headstone and no burial --
 * nothing anywhere could take a finished run off an ambient pane.
 *
 * IT ACKNOWLEDGES, IT DOES NOT DELETE. The run artifact and its baton stay on
 * disk; all this writes is "a human has seen this end". The sentinel refuses it
 * on a live run, so the worst a stray click can do is nothing. `delete` is the
 * other answer and lives next door.
 *
 * ARMS ON THE FIRST CLICK, like every other verb on this pane -- the machine is
 * `useArmedAction`, which also holds the reason it is a second click and not a
 * native confirm.
 */

import { clearEpicRun } from '@/lib/epic-run-api'
import { cn } from '@/lib/utils'
import { useArmedAction } from './use-armed-action'

export function RunClearButton({ project, epicId, onDone }: { project: string; epicId: string; onDone: () => void }) {
  const { armed, busy, note, press } = useArmedAction(() => clearEpicRun(project, epicId), onDone, 'clear failed')

  return (
    <>
      <button
        type="button"
        title="Acknowledge this run: it leaves the wall. The run file, its baton and every card stay on disk."
        disabled={busy}
        aria-pressed={armed}
        onClick={press}
        className={cn('wall-run-act', armed && 'wall-run-act-armed')}
      >
        {busy ? '...' : armed ? 'clear -- sure?' : 'clear'}
      </button>
      {note && <span className="wall-run-note">{note}</span>}
    </>
  )
}
