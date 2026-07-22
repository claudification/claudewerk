/**
 * The SUMMON LATCH: is the orb here, and should the session be running?
 *
 * Split out of the host so the latch is testable on its own -- it is the part
 * with rules (toggle semantics, start-once, auto-dismiss on a dead session,
 * doze after quiet), while the host is just what you see.
 */

import { useCallback, useEffect, useState } from 'react'
import { useIdleTimeout } from '@/hooks/use-idle-timeout'
import { voiceOrbBus } from './voice-orb-bus'

/** Quiet time before the orb dozes. The session stays live; talking wakes it. */
export const DOZE_MS = 20_000
/** Quiet time before the orb LEAVES: session closed, mic released. */
export const IDLE_TIMEOUT_MS = 300_000
/** How long before that the orb says it is about to go. */
export const IDLE_WARN_LEAD_MS = 30_000

export interface OrbSummonInput {
  /** Start the realtime session (idempotent -- the hook guards its own state). */
  start(): Promise<void> | void
  /** Tear down the session and release the mic. */
  stop(): void
  /** Is a session currently up? */
  live: boolean
  /** Last error from the session, if any. */
  error: string | null
  /** Changes whenever the orb does anything -- re-arms the doze timer. */
  activity: string
}

export interface OrbSummon {
  summoned: boolean
  dozing: boolean
  /** The orb is about to leave on its own (the last ~30s). */
  leavingSoon: boolean
  /** Ms left before it does, while `leavingSoon`. */
  leavingInMs: number
  /** It DID leave on its own -- show the "stepped away" notice once. */
  steppedAway: boolean
  acknowledgeSteppedAway(): void
  /** Dismiss from the UI (the orb's own close button). */
  dismiss(): void
}

export function useOrbSummon({ start, stop, live, error, activity }: OrbSummonInput): OrbSummon {
  const [summoned, setSummoned] = useState(false)
  const [dozing, setDozing] = useState(false)
  const [steppedAway, setSteppedAway] = useState(false)

  // Left alone, the orb leaves: a forgotten session is a hot mic and a live
  // realtime bill. Distinct from doze (which only dims the visual).
  const onTimeout = useCallback(() => {
    setSummoned(false)
    setSteppedAway(true)
    stop()
  }, [stop])
  const idle = useIdleTimeout({
    active: summoned,
    totalMs: IDLE_TIMEOUT_MS,
    warnLeadMs: IDLE_WARN_LEAD_MS,
    onTimeout,
  })

  // Anything the orb says or does counts as company.
  const { pulse } = idle
  // biome-ignore lint/correctness/useExhaustiveDependencies: `activity` is the SIGNAL -- listed to re-arm the idle span, not read in the body.
  useEffect(() => pulse(), [activity, pulse])

  // The palette verb lands here: toggle = summon if away, dismiss if present.
  useEffect(() => {
    voiceOrbBus.setHandler(intent => {
      setSteppedAway(false)
      setSummoned(was => {
        const next = intent === 'summon' ? true : intent === 'dismiss' ? false : !was
        if (!next) stop()
        return next
      })
    })
    return () => voiceOrbBus.setHandler(null)
  }, [stop])

  // Start on summon. `start` is expected to no-op when already running.
  useEffect(() => {
    if (summoned) void start()
  }, [summoned, start])

  // A session that dies on its own (transport drop, mint refusal) un-summons,
  // so the orb never lingers as a dead decoration.
  useEffect(() => {
    if (summoned && !live && error) setSummoned(false)
  }, [summoned, live, error])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `activity` is the activity SIGNAL -- listed to re-arm the timer when it changes, not read in the body.
  useEffect(() => {
    setDozing(false)
    if (!summoned) return
    const t = setTimeout(() => setDozing(true), DOZE_MS)
    return () => clearTimeout(t)
  }, [activity, summoned])

  return {
    summoned,
    dozing,
    leavingSoon: idle.warning,
    leavingInMs: idle.remainingMs,
    steppedAway,
    acknowledgeSteppedAway: () => setSteppedAway(false),
    dismiss: () => {
      setSummoned(false)
      stop()
    },
  }
}
