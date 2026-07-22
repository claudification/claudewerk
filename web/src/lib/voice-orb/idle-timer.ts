/**
 * The idle timer, as plain objects: arm a span, warn a fixed lead before it
 * ends, fire at the end, and re-arm from zero on any activity.
 *
 * Deliberately NOT a hook -- timer logic nested inside `useCallback`s becomes a
 * knot. Here each phase is a method, testable with fake timers and no React.
 * `use-idle-timeout.ts` is the thin wrapper that binds it to component state.
 */

export interface IdleTimerSpec {
  totalMs: number
  warnLeadMs: number
  tickMs: number
}

export interface IdleTimerHandlers {
  /** The warning window opened. */
  onWarn(): void
  /** The full span elapsed with no activity. */
  onTimeout(): void
  /** Countdown update while warning (ms left). */
  onRemaining(ms: number): void
}

export class IdleTimer {
  private warnTimer: ReturnType<typeof setTimeout> | null = null
  private endTimer: ReturnType<typeof setTimeout> | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private remaining = 0

  /** `read` is called fresh each time, so live option/callback changes apply
   *  without re-arming (the caller keeps them in refs). */
  constructor(private readonly read: () => { spec: IdleTimerSpec; handlers: IdleTimerHandlers }) {}

  clear(): void {
    if (this.warnTimer) clearTimeout(this.warnTimer)
    if (this.endTimer) clearTimeout(this.endTimer)
    if (this.ticker) clearInterval(this.ticker)
    this.warnTimer = null
    this.endTimer = null
    this.ticker = null
  }

  /** Re-arm from zero. */
  arm(): void {
    this.clear()
    const { spec } = this.read()
    this.warnTimer = setTimeout(this.beginWarning, Math.max(0, spec.totalMs - spec.warnLeadMs))
    this.endTimer = setTimeout(this.end, spec.totalMs)
  }

  private readonly beginWarning = (): void => {
    const { spec, handlers } = this.read()
    this.remaining = spec.warnLeadMs
    handlers.onRemaining(this.remaining)
    handlers.onWarn()
    this.ticker = setInterval(this.tick, spec.tickMs)
  }

  private readonly tick = (): void => {
    const { spec, handlers } = this.read()
    this.remaining = Math.max(0, this.remaining - spec.tickMs)
    handlers.onRemaining(this.remaining)
  }

  private readonly end = (): void => {
    this.clear()
    this.read().handlers.onTimeout()
  }
}
