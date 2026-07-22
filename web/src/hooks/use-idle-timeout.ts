/**
 * React wrapper around the plain IdleTimer: arm while `active`, warn a fixed
 * lead before the span ends, fire `onTimeout` at the end, `pulse()` to re-arm.
 *
 * The voice orb wires it as: active while summoned, pulse on every speech /
 * transcript / tool event, onTimeout -> close the session and release the mic.
 * All the timer logic lives in lib/voice-orb/idle-timer.ts; this file is state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IdleTimer } from '@/lib/voice-orb/idle-timer'

export interface IdleTimeoutOptions {
  /** Arm the timers while true; clear + reset them while false. */
  active: boolean
  /** Total idle span before timeout fires (ms). */
  totalMs: number
  /** How far before timeout the warning fires (ms). */
  warnLeadMs: number
  /** Fired once when the warning window opens. */
  onWarn?: () => void
  /** Fired when the full idle span elapses with no pulse. */
  onTimeout: () => void
  /** Countdown refresh granularity while warning (ms). */
  tickMs?: number
}

export interface IdleTimeout {
  /** Is the warning window currently open? */
  warning: boolean
  /** Ms left until timeout while warning (else the warn lead). */
  remainingMs: number
  /** Register activity: re-arm from zero, dismissing any open warning. No-op
   *  while inactive. Stable identity -- safe in callback deps. */
  pulse: () => void
}

export function useIdleTimeout(opts: IdleTimeoutOptions): IdleTimeout {
  const { active, totalMs, warnLeadMs, onWarn, onTimeout, tickMs = 250 } = opts

  const [warning, setWarning] = useState(false)
  const [remainingMs, setRemainingMs] = useState(warnLeadMs)

  // Read through a ref so live option/callback changes apply to an already-armed
  // timer -- re-arming on every render would mean it never fires.
  const latest = useRef({ totalMs, warnLeadMs, tickMs, onWarn, onTimeout })
  latest.current = { totalMs, warnLeadMs, tickMs, onWarn, onTimeout }
  const activeRef = useRef(active)

  const timerRef = useRef<IdleTimer | null>(null)
  if (timerRef.current === null) {
    timerRef.current = new IdleTimer(() => ({
      spec: {
        totalMs: latest.current.totalMs,
        warnLeadMs: latest.current.warnLeadMs,
        tickMs: latest.current.tickMs,
      },
      handlers: {
        onWarn: () => {
          setWarning(true)
          latest.current.onWarn?.()
        },
        onTimeout: () => {
          setWarning(false)
          latest.current.onTimeout()
        },
        onRemaining: setRemainingMs,
      },
    }))
  }
  const timer = timerRef.current

  const pulse = useCallback(() => {
    if (!activeRef.current) return
    setWarning(false)
    timer.arm()
  }, [timer])

  useEffect(() => {
    activeRef.current = active
    if (!active) {
      timer.clear()
      setWarning(false)
      return
    }
    timer.arm()
    return () => timer.clear()
  }, [active, timer])

  return { warning, remainingMs, pulse }
}
