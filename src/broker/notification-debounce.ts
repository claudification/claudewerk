/**
 * Keyed once-per-window notification debounce.
 *
 * One notification per key per window; everything else in the window is
 * dropped/coalesced. This generalises the inline `lastTranscriptKick`
 * timestamp-Map pattern (conversation-store/add-event.ts) into a reusable
 * primitive so notification throttles stop being re-implemented by hand.
 *
 * Distinct from the two neighbouring throttles, on purpose:
 *  - `SlidingWindowRateLimiter` (dialog-rate-limit.ts) allows N hits per window.
 *    This allows exactly ONE.
 *  - `attention-notify.ts` schedules a *delayed* cancellable fire (push after
 *    4min idle). This is a fire-now-then-suppress debounce, not a delay.
 *
 * Pure + injectable clock so tests are deterministic.
 */

export interface NotifyDebounceConfig {
  windowMs: number
}

/** Default "one notification per ~10 minutes at most" window. */
export const DEFAULT_NOTIFY_WINDOW_MS = 10 * 60_000

export class NotificationDebouncer {
  private readonly last = new Map<string, number>()

  constructor(private readonly cfg: NotifyDebounceConfig) {}

  /**
   * Check-and-record atomically. Returns `true` (and records `now` as the
   * key's last-notified time) iff the key has never fired OR the window has
   * elapsed since its last recorded notification; otherwise returns `false`
   * and records nothing. Within-window comparison is `now - last > windowMs`
   * (strictly greater), matching the original transcript-kick debounce. The
   * never-fired case is always allowed regardless of the absolute clock value
   * (so an injected `now: 0` still fires the first time).
   */
  shouldNotify(key: string, now: number = Date.now()): boolean {
    if (this.canNotify(key, now)) {
      this.last.set(key, now)
      return true
    }
    return false
  }

  /** Read-only variant of {@link shouldNotify} -- never records. */
  canNotify(key: string, now: number = Date.now()): boolean {
    const last = this.last.get(key)
    if (last === undefined) return true
    return now - last > this.cfg.windowMs
  }

  /**
   * Forget a key (or everything when omitted). Used to re-arm a key the moment
   * its underlying condition clears -- e.g. a profile's auth recovers -- so the
   * NEXT failure notifies immediately instead of waiting out the window.
   */
  reset(key?: string): void {
    if (key === undefined) this.last.clear()
    else this.last.delete(key)
  }
}
