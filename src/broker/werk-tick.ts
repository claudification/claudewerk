/**
 * THE WERK TICK -- one interval, one reentrancy guard, one quarantine check.
 *
 * WERK's triggers each used to start their own loop. The epic sweep had a
 * module-level `sweeping` flag; the nightshift guardians had NONE and relied on
 * the sweep finishing inside 45s, which is exactly the assumption a slow
 * sentinel breaks. Neither knew about the restart quarantine unless someone
 * remembered to add it.
 *
 * Making the loop a primitive is what stops that being a matter of memory: a
 * trigger cannot start a tick that forgets the guard or the quarantine, because
 * there is no way to start one without them.
 *
 * WHY THE GUARD MATTERS. A sweep does several sentinel round trips. When the
 * sentinel is slow -- the one time it counts -- a second tick fires on top of
 * the first, both read the same state, and both act on it. For the epic trigger
 * that means two beats dispatching the same ready card past the concurrency
 * ceiling; for nightshift it means two orphan handlers poking the same task. The
 * guard is cheaper and far more obvious than making every action idempotent.
 */

import { quarantineLogLine, quarantineRemainingMs } from './werk-engine-boot'

export interface WerkTickOptions {
  /** Log prefix, e.g. `[epic-sweep]`. Appears in every skip and hold line. */
  tag: string
  intervalMs: number
  /** The work itself. Rejections are caught and logged, never thrown at the timer. */
  run: () => Promise<void>
  log: (line: string) => void
  /** Injected so a tick's clock is not the test's wall clock. */
  now: () => number
  /**
   * Runs even when the tick is quarantined or skipped. The activity publisher
   * needs this: a run that is WAITING must still reach the panel, or a held
   * engine is indistinguishable from a dead one.
   */
  always?: () => Promise<void>
}

export interface WerkTick {
  /** Run one tick right now. Returns what it did, so a caller can say why. */
  once: () => Promise<'ran' | 'busy' | 'quarantined'>
  stop: () => void
}

/**
 * Start a guarded tick. The returned `once` is the SAME path the interval takes,
 * guard and all -- a "beat now" verb that bypassed the guard would reintroduce
 * precisely the double-dispatch the guard exists to prevent.
 */
export function startWerkTick(opts: WerkTickOptions): WerkTick {
  let running = false

  const once = async (): Promise<'ran' | 'busy' | 'quarantined'> => {
    if (running) {
      opts.log(`${opts.tag} previous tick still running; skipping`)
      return 'busy'
    }
    const remaining = quarantineRemainingMs(opts.now())
    if (remaining > 0) {
      opts.log(quarantineLogLine(opts.tag, remaining))
      await opts.always?.()
      return 'quarantined'
    }
    running = true
    try {
      await opts.run()
    } catch (err) {
      // Swallowed on purpose: a crash in one tick must never stop the timer, or
      // one bad sweep silently ends the engine for the life of the process.
      opts.log(`${opts.tag} tick crashed -- swallowing: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      running = false
    }
    await opts.always?.()
    return 'ran'
  }

  const timer = setInterval(() => void once(), opts.intervalMs)
  return {
    once,
    stop: () => {
      clearInterval(timer)
      opts.log(`${opts.tag} stopped`)
    },
  }
}
