/**
 * Virtualizer Lab -- per-device experiment knobs for the TanStack transcript
 * virtualizer. Every default reproduces CURRENT production behavior exactly,
 * so a fresh device changes nothing. The Experiments settings tab flips these
 * live (zustand prefs, localStorage) so scroll/follow experiments can be A/B
 * tested on-device without a rebuild per variant.
 *
 * Background: the transcript has TWO follow drivers (our totalSize-growth pin
 * effect + virtual-core's native wasAtEnd end-pin inside resizeItem) and all
 * in-flight UI (streaming blocks, pill, spinner, banners, queued bubbles)
 * renders INSIDE the last virtual item. Each knob isolates one of those
 * mechanisms. See memory: project_transcript_follow_workstream.
 */

export interface VirtualizerLabPrefs {
  /** Native scroll-on-new-item when already pinned. OFF in prod: its instant
   *  scroll used to race our manual pin. */
  followOnAppend: boolean
  /** px from the (estimated) end within which native still counts the view as
   *  "at end" -- gates the native wasAtEnd re-pin on in-place growth. */
  scrollEndThreshold: number
  /** Force scrollEndThreshold to 0 while follow is OFF, so the native end-pin
   *  can never drag a detached reader to the bottom (the "detached forced
   *  scroll" fix candidate -- plan-transcript-detached-forced-scroll Step 2). */
  gateNativePinWhenDetached: boolean
  /** Our manual totalSize-growth scrollToEnd effect. OFF = native wasAtEnd pin
   *  is the SOLE follow driver (the single-driver experiment). */
  manualGrowthPin: boolean
  /** How every follow/switch pin reaches the bottom. 'scrollToEnd' = the
   *  virtualizer's item-math target (can undershoot in-flight content inside
   *  the last item); 'scrollHeight' = el.scrollTop = el.scrollHeight (exact
   *  DOM bottom, includes outside-rendered content). */
  pinMethod: 'scrollToEnd' | 'scrollHeight'
  /** Streaming thinking/text + pill + spinner: inside the last virtual item
   *  (measured, native pin sees their growth) or outside the virtualizer
   *  (unmeasured; growth pinned by a dedicated ResizeObserver while following). */
  inFlightPlacement: 'inside' | 'outside'
  /** Permission/link/spawn/question banners + queued bubbles: same choice. */
  bannersPlacement: 'inside' | 'outside'
  /** Use the native `scrollend` event (where supported) instead of the
   *  isScrollingResetDelay timeout to end virtual-core's isScrolling state. */
  useScrollendEvent: boolean
  /** ms after the last scroll event before virtual-core drops isScrolling
   *  (affects scroll-direction latching and resize compensation). */
  isScrollingResetDelay: number
  /** Items rendered beyond the visible range. */
  overscan: number
  /** First-frame height estimate (px) for the synthetic live group. Its snap
   *  to the real measured height is a residual jump suspect. */
  liveEstimate: number
}

export const DEFAULT_VIRTUALIZER_LAB: VirtualizerLabPrefs = {
  followOnAppend: false,
  scrollEndThreshold: 80,
  gateNativePinWhenDetached: false,
  manualGrowthPin: true,
  pinMethod: 'scrollToEnd',
  inFlightPlacement: 'inside',
  bannersPlacement: 'inside',
  useScrollendEvent: false,
  isScrollingResetDelay: 150,
  overscan: 5,
  liveEstimate: 80,
}

/** Merge a possibly-partial stored value over the defaults (prefs written by
 *  an older build simply lack newer knobs). */
export function resolveVirtualizerLab(stored: Partial<VirtualizerLabPrefs> | undefined): VirtualizerLabPrefs {
  return { ...DEFAULT_VIRTUALIZER_LAB, ...stored }
}

/** Compact "knob=value" list of every non-default knob, or null when the lab
 *  is entirely at defaults. Logged as `[lab] ...` so device logs always name
 *  the configuration under test. */
export function labSummary(lab: VirtualizerLabPrefs): string | null {
  const diffs: string[] = []
  for (const key of Object.keys(DEFAULT_VIRTUALIZER_LAB) as Array<keyof VirtualizerLabPrefs>) {
    if (lab[key] !== DEFAULT_VIRTUALIZER_LAB[key]) diffs.push(`${key}=${lab[key]}`)
  }
  return diffs.length > 0 ? diffs.join(' ') : null
}
