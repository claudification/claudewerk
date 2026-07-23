/**
 * The voice orb's HOST: the summon LATCH and the restart generation.
 *
 * SUMMON MODEL -- the orb is summoned from the command palette, which mounts the
 * live session (<OrbSession>) and makes the orb appear. The orb IS the presence;
 * dismissing it unmounts the session and releases the mic. It is a fixed
 * floating element (like the voice FAB), NOT a managed/parkable surface -- the
 * DETACHABLE SURFACES covenant covers panels, not the orb.
 *
 * RESTART IS A REMOUNT. This host owns nothing about the session itself; it owns
 * a `generation` counter that keys <OrbSession>. Bumping it unmounts the old
 * session (mic + audio sink + analyser all torn down) and mounts a clean one --
 * the only way to (a) change the output voice, which OpenAI locks after the orb
 * speaks, and (b) actually restore sound on "Restart the orb". The session
 * reports its live/error/activity back up so the latch can doze + auto-dismiss a
 * dead session without reaching into it.
 *
 * Lives inside the lazy chunk armed by voiceOrbBus, so nothing here (or below
 * it) reaches the index bundle until the first summon.
 */

import { useCallback, useEffect, useState } from 'react'
import { OrbSession, type SessionSignal } from './orb-session'
import { useOrbSummon } from './use-orb-summon'

/** No session mounted -- the signal the latch starts from and returns to. */
const IDLE_SIGNAL: SessionSignal = { live: false, error: null, activity: 'idle:' }
/** Mount/unmount of <OrbSession> is start/stop now, so the latch's own
 *  start/stop are inert. Module-level for a stable identity across renders. */
const NOOP = () => {}

export function VoiceOrbHost() {
  // The KEY of the session subtree: a bump remounts it (fresh mic + audio).
  const [generation, setGeneration] = useState(0)
  // The session lives in the child; lift the signals the latch needs to see.
  const [signal, setSignal] = useState<SessionSignal>(IDLE_SIGNAL)
  const restart = useCallback(() => setGeneration(g => g + 1), [])

  const summon = useOrbSummon({
    start: NOOP,
    stop: NOOP,
    live: signal.live,
    error: signal.error,
    activity: signal.activity,
  })
  const { summoned, dozing, steppedAway, acknowledgeSteppedAway } = summon

  // Left alone long enough, the orb leaves and says so through the app's own
  // toast -- no bespoke modal for a five-second message.
  useEffect(() => {
    if (!steppedAway) return
    window.dispatchEvent(
      new CustomEvent('rclaude-toast', {
        detail: {
          title: 'The orb stepped away',
          body: 'Quiet for five minutes, so it closed the voice session and switched the mic off. Summon it again whenever.',
        },
      }),
    )
    acknowledgeSteppedAway()
  }, [steppedAway, acknowledgeSteppedAway])

  // Forget the last session's signal once dismissed, so a stale `live` never
  // trips the auto-dismiss rule on the next summon.
  useEffect(() => {
    if (!summoned) setSignal(IDLE_SIGNAL)
  }, [summoned])

  if (!summoned) return null
  return (
    <OrbSession
      key={generation}
      dozing={dozing}
      leavingSoon={summon.leavingSoon}
      leavingInMs={summon.leavingInMs}
      onSignal={setSignal}
      onReloadRequest={restart}
      onDismiss={summon.dismiss}
    />
  )
}
