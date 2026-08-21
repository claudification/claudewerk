/**
 * ARM-THEN-CONFIRM, said once.
 *
 * Every verb on the wall's tail row is two clicks: the first arms, the second
 * does it, and an armed button disarms itself on a timer so a half-pressed
 * gesture cannot be finished by a stray click an hour later. THE GATE IS A
 * SECOND CLICK AND NOT `window.confirm` because a wall is often a DETACHED
 * window on another monitor, where a native modal steals focus from the main
 * screen and blocks the whole surface's repaint until it is dismissed.
 *
 * Extracted when `delete` landed beside `clear`, because the two buttons had
 * become the same twenty lines twice: the same `armed`/`busy`/`note` triple, the
 * same self-disarm effect, the same "a REFUSAL IS THE INTERESTING ANSWER" rule.
 * A second copy of that rule is a second place for it to rot -- and the rule is
 * the whole reason the tail row is allowed to have controls at all.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN: the label, the title, the class names. Two
 * buttons that behave identically and LOOK identical would be worse than the
 * duplication -- `delete` sits directly beside `clear` and must not read as the
 * same control one button over. The hook is the machine; the button is the face.
 */

import { useEffect, useState } from 'react'
import { haptic } from '@/lib/utils'
import { ARM_TIMEOUT_MS } from './run-actions'

/** What a verb answers with. Only two things matter to the machine: did it
 *  happen, and what should the row say if it did not. */
export interface ArmedActionReply {
  ok: boolean
  error?: string
}

export interface ArmedAction {
  /** One more click does it. Drives the label and `aria-pressed`. */
  armed: boolean
  /** In flight. Drives `disabled`, so a double-tap cannot send twice. */
  busy: boolean
  /** THE REFUSAL, or null. A button that swallowed this would leave the row on
   *  the pane with no reason given -- the silence this section exists to end. */
  note: string | null
  press: () => void
}

/**
 * @param run    the verb itself. Called only on the SECOND click.
 * @param onDone re-read the pane. Called only when the verb actually happened --
 *               a refused verb changed nothing, so re-reading would be a
 *               request that can only return the same row.
 * @param failed the line to show when the verb refuses without saying why.
 */
export function useArmedAction(run: () => Promise<ArmedActionReply>, onDone: () => void, failed: string): ArmedAction {
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
    const reply = await run()
    setBusy(false)
    setNote(reply.ok ? null : reply.error || failed)
    if (reply.ok) onDone()
  }

  return { armed, busy, note, press: () => void press() }
}
