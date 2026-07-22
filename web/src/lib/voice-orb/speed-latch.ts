/**
 * THE SPEAKING-RATE LATCH -- why the slider used to do nothing.
 *
 * OpenAI's own docs on `audio.output.speed`: "This value can only be changed in
 * between model turns, not while a response is in progress." The panel pushed
 * the dial the instant it moved, which is usually exactly when the orb is
 * TALKING -- so the update was dropped on the floor and nothing ever re-sent it.
 * The session then kept the rate it was minted with, for its whole life, and the
 * slider looked broken because it WAS.
 *
 * So: hold the wanted rate, apply it only at a turn boundary, and never send a
 * rate the session already has (a redundant `session.update` is a free way to
 * eat an API error on a live orb).
 */

export interface SpeedLatch {
  /** The rate the user wants. Applied now if the orb is between turns. */
  want(speed: number): void
  /** The session was minted at this rate -- the baseline, sent by nobody. */
  minted(speed: number): void
  /** A turn just ended: flush whatever the API would have dropped mid-response. */
  turnEnded(): void
  /** What the live session is actually speaking at, as far as we know. */
  applied(): number | null
}

export interface SpeedLatchConfig {
  /** True while a response is in flight (or the transport is not up yet) -- the
   *  window where the API ignores a rate change. */
  isBusy(): boolean
  /** Push the rate to the live session. */
  apply(speed: number): void
}

export function createSpeedLatch(cfg: SpeedLatchConfig): SpeedLatch {
  let wanted: number | null = null
  let applied: number | null = null

  const flush = (): void => {
    if (wanted === null || wanted === applied || cfg.isBusy()) return
    applied = wanted
    cfg.apply(wanted)
  }

  return {
    want(speed) {
      wanted = speed
      flush()
    },
    minted(speed) {
      applied = speed
      if (wanted === null) wanted = speed
    },
    turnEnded: flush,
    applied: () => applied,
  }
}
