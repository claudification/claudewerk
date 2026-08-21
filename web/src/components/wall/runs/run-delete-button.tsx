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
 * SAME MACHINE AS `clear`, DIFFERENT FACE. The arm-then-confirm behaviour is
 * `useArmedAction`, shared with the button next door; what is NOT shared is how
 * it looks, because the two sit side by side and are not interchangeable -- a
 * click that lands one button over must not read as the same gesture. The armed
 * label carries the one fact a human will otherwise get wrong: the CARDS
 * survive.
 */

import { deleteEpicRun } from '@/lib/epic-inspect-api'
import { cn } from '@/lib/utils'
import { useArmedAction } from './use-armed-action'

const TITLE =
  'Remove this run from the record. The run file and its baton are MOVED to ' +
  '.rclaude/project/epics/.deleted/, not destroyed. Its CARDS are NOT deleted. ' +
  'Refused while the run is armed or running, or while any of its conversations is still live.'

export function RunDeleteButton({ project, epicId, onDone }: { project: string; epicId: string; onDone: () => void }) {
  const { armed, busy, note, press } = useArmedAction(
    () => deleteEpicRun(project, epicId, 'deleted from the wall'),
    onDone,
    'delete failed',
  )

  return (
    <>
      <button
        type="button"
        title={TITLE}
        disabled={busy}
        aria-pressed={armed}
        onClick={press}
        className={cn('wall-run-act wall-run-act-danger', armed && 'wall-run-act-danger-armed')}
      >
        {busy ? '...' : armed ? 'delete run, keep cards -- sure?' : 'delete'}
      </button>
      {note && <span className="wall-run-note">{note}</span>}
    </>
  )
}
