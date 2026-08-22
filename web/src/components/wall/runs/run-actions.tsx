/**
 * BEAT NOW / PAUSE / RESUME, each behind a two-step confirm.
 *
 * THE VERBS ARE NOT REIMPLEMENTED HERE. `werk-master-verbs.ts` already holds them
 * and already decides what each one reports back; this file is the wall's
 * GATE in front of them, nothing else.
 *
 * ABORT IS DELIBERATELY ABSENT. A terminal, unresumable action does not belong
 * on a surface whose whole purpose is to be glanced at from across a room. The
 * werk-master window has it, behind its own confirm, and that is the right place.
 *
 * THE GATE IS A SECOND CLICK, NOT `window.confirm`. A wall is often a DETACHED
 * window sitting on another monitor: a native modal there steals focus from
 * whatever is on the main screen and blocks the whole surface's repaint until it
 * is dismissed. Arming in place costs one extra click, keeps the pane live, and
 * says exactly which run it is about to touch. It disarms on a timer so a
 * half-pressed button cannot sit there waiting to be finished by a stray click
 * an hour later.
 */

import type { EpicRunSnapshot } from '@shared/protocol'
import { useEffect, useState } from 'react'
import { cn, haptic } from '@/lib/utils'
import { VERBS, type Verb } from '../../werk-master/werk-master-verbs'

/** How long an armed button stays armed. Long enough to finish the gesture,
 *  short enough that it is never still armed when you look back. */
export const ARM_TIMEOUT_MS = 4_000

/** The three the card allows, and what each is FOR. */
const LABEL: Record<string, { idle: string; armed: string; title: string }> = {
  beat: {
    idle: 'beat now',
    armed: 'beat -- sure?',
    title: 'Run one beat immediately instead of waiting for the sweep. A refusal means the sweep is mid-tick.',
  },
  pause: {
    idle: 'pause',
    armed: 'pause -- sure?',
    title: 'Stop beating. The baton is kept and a later RESUME picks up at this generation.',
  },
  resume: {
    idle: 'resume',
    armed: 'resume -- sure?',
    title: 'Carry on from the pause. Never re-plans and never restarts the generation count.',
  },
}

export interface RunActionsProps {
  project: string
  epicId: string
  run: EpicRunSnapshot | null
  /** Armed or running -- decides whether the second button pauses or resumes. */
  live: boolean
  /** Re-read the run: what just happened is not in the last inspect. */
  onDone: () => void
}

export function RunActions({ project, epicId, run, live, onDone }: RunActionsProps) {
  const [armed, setArmed] = useState<Verb | null>(null)
  const [busy, setBusy] = useState<Verb | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(null), ARM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [armed])

  async function press(verb: Verb): Promise<void> {
    // FIRST CLICK ARMS, and arming one verb disarms the other -- so a click that
    // lands on the wrong button can never complete the right one's confirm.
    if (armed !== verb) {
      setArmed(verb)
      setNote(null)
      return
    }
    setArmed(null)
    haptic('tap')
    setBusy(verb)
    setNote(await VERBS[verb]({ project, epicId, run }))
    setBusy(null)
    onDone()
  }

  const verbs: Verb[] = ['beat', live ? 'pause' : 'resume']

  return (
    <div className="wall-run-acts">
      {verbs.map(verb => {
        const label = LABEL[verb]
        const isArmed = armed === verb
        return (
          <button
            key={verb}
            type="button"
            title={label?.title}
            disabled={busy !== null}
            aria-pressed={isArmed}
            onClick={() => void press(verb)}
            className={cn('wall-run-act', isArmed && 'wall-run-act-armed')}
          >
            {busy === verb ? '...' : isArmed ? label?.armed : label?.idle}
          </button>
        )
      })}
      {note && <span className="wall-run-note">{note}</span>}
    </div>
  )
}
