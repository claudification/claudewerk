/**
 * Assign a task to a project's nightshift (plan §3, the INPUT side). A freeform
 * form; tagging an existing project-board card is the other path (the card
 * editor's Nightshift button). This is the hand-typed one.
 *
 * IT FILES A CARD NOW, NOT A QUEUE ENTRY. This used to call the `enqueue` op,
 * which wrote a standalone task into `.nightshift/queue/` -- a second store,
 * with its own copy of a title and a body, that the board could not see. The
 * night run's input is the `#nightshift` TAG on a board card, so a form that
 * kept writing to the queue would have been a door into a room the engine no
 * longer enters: it would appear to work and nothing would ever run.
 *
 * So a hand-typed task becomes a real card carrying the tag. It shows up on the
 * board, it can be refined, and it is the same object the run will read.
 *
 * `risk`, `feasibility` and `acceptance` are folded into the card BODY rather
 * than frontmatter: they are queue-item fields and a board card has no such
 * keys. Keeping the inputs and writing them as prose loses nothing a night
 * worker reads (it gets the body) and invents no card schema, which is a
 * decision for whoever revives the run engine, not for this card.
 */

import { NIGHTSHIFT_TAG, type NightshiftFeasibility, type NightshiftRisk } from '@shared/nightshift-types'
import { Moon } from 'lucide-react'
import { useState } from 'react'
import { sendBoardOp } from '@/hooks/project-task-wire'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'

const RISKS: NightshiftRisk[] = ['low', 'medium', 'high']
const FEASIBILITIES: NightshiftFeasibility[] = ['feasible', 'uncertain', 'infeasible']

const inputClass =
  'w-full bg-muted/40 border border-border text-xs px-2 py-1.5 outline-none focus:border-accent rounded'

/** Trimmed string, or undefined when empty (so blank fields drop out of the frontmatter). */
const trimmed = (s: string): string | undefined => s.trim() || undefined
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'failed to assign')

export function AssignTasksDialog({
  projectUri,
  open,
  onOpenChange,
}: {
  projectUri: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [risk, setRisk] = useState<NightshiftRisk | ''>('')
  const [feasibility, setFeasibility] = useState<NightshiftFeasibility | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setTitle('')
    setDescription('')
    setAcceptance('')
    setRisk('')
    setFeasibility('')
    setError(null)
  }

  /** The card body: what was typed, plus the two nightshift qualifiers as prose
   *  so nothing entered here is silently dropped. */
  function buildBody() {
    const qualifiers = [risk && `risk: ${risk}`, feasibility && `feasibility: ${feasibility}`].filter(Boolean)
    return [
      trimmed(description) ?? '',
      trimmed(acceptance) && `## Acceptance\n${acceptance.trim()}`,
      qualifiers.length > 0 && `_${qualifiers.join(' -- ')}_`,
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  async function submit() {
    if (!title.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const resp = await sendBoardOp(projectUri, 'create', {
        input: { title: title.trim(), body: buildBody(), tags: [NIGHTSHIFT_TAG] },
      })
      if (!resp.ok) throw new Error((resp.error as string) || 'failed to file the card')
      reset()
      onOpenChange(false)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Moon className="size-4 text-amber-400" />
          <DialogTitle className="text-xs">Assign a task to nightshift</DialogTitle>
        </div>
        <div className="p-3 space-y-2.5">
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            aria-label="Task title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Task title (required)"
            className={inputClass}
          />
          <textarea
            aria-label="Task description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="What should the night run do? (optional)"
            rows={3}
            className={`${inputClass} resize-none`}
          />
          <input
            aria-label="Acceptance criteria"
            value={acceptance}
            onChange={e => setAcceptance(e.target.value)}
            placeholder="Acceptance criteria (optional)"
            className={inputClass}
          />
          <div className="flex gap-2">
            <select
              value={risk}
              onChange={e => setRisk(e.target.value as NightshiftRisk)}
              className={`${inputClass} flex-1`}
            >
              <option value="">risk…</option>
              {RISKS.map(r => (
                <option key={r} value={r}>
                  {r} risk
                </option>
              ))}
            </select>
            <select
              value={feasibility}
              onChange={e => setFeasibility(e.target.value as NightshiftFeasibility)}
              className={`${inputClass} flex-1`}
            >
              <option value="">feasibility…</option>
              {FEASIBILITIES.map(f => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          {error && <div className="text-[10px] text-red-400">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-xs px-3 py-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!title.trim() || busy}
              onClick={submit}
              className="text-xs font-bold px-3 py-1 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
