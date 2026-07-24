/**
 * Plain Renderer Lab -- per-device experiment knobs for the plain
 * (non-virtualized) transcript renderer's SCROLL-BACK machinery. Stick-to-
 * bottom is settled; the open problem is keeping the reader's position stable
 * while older history loads and content-visibility groups inflate from their
 * estimate to real height. Every default reproduces CURRENT production
 * behavior exactly, so a fresh device changes nothing. The Experiments
 * settings tab flips these live (zustand prefs, localStorage) so we can A/B
 * the anchoring approaches on-device without a rebuild per variant.
 *
 * The four mechanisms under test (see plain/ + globals.css):
 *  - content-visibility: auto + contain-intrinsic-size on each group. Skips
 *    offscreen layout, but seeds a flat estimate that inflates to real height
 *    on first encounter -- the scroll-back jump amplifier.
 *  - prepend anchor (use-prepend-anchor.ts): scrollHeight-delta compensation
 *    on the commit where older content lands. The classic Safari-safe trick.
 *  - above-viewport anchor (use-above-anchor.ts): ResizeObserver polyfill that
 *    compensates the estimate->real inflation of groups above the viewport.
 *  - overflow-anchor: browser-native scroll anchoring. 'none' today (it would
 *    double-compensate the prepend anchor); 'auto' hands the job to Chrome/
 *    Firefox natively (Safari has no support either way).
 * See memory: project_transcript_scrollback_hold, project_transcript_plain_renderer.
 */

export interface PlainRendererLabPrefs {
  /** content-visibility:auto on each group (offscreen layout skipping). OFF =
   *  plain document flow, real heights from first layout, so nothing inflates
   *  above the viewport -- kills the jump at the source (costs offscreen-skip
   *  perf on very large windows). */
  contentVisibility: boolean
  /** contain-intrinsic-size estimate (px) for a not-yet-rendered group. Only
   *  meaningful while contentVisibility is ON. The flat 200px default is far
   *  below typical group heights, so first-encounter inflation is large;
   *  raising it trades one jump direction for the other. */
  intrinsicSize: number
  /** scrollHeight-delta prepend anchor (use-prepend-anchor.ts). The proven
   *  Safari-safe compensation applied when older content is inserted above. */
  prependAnchor: boolean
  /** above-viewport ResizeObserver anchor (use-above-anchor.ts). Compensates a
   *  content-visibility group inflating from estimate to real height while it
   *  sits above the viewport. Redundant when contentVisibility is OFF. */
  aboveAnchor: boolean
  /** CSS overflow-anchor on the scroller. 'none' = we own anchoring in JS
   *  (today). 'auto' = native browser scroll anchoring drives it (Chrome/
   *  Firefox); pair with the JS anchors OFF to avoid double-compensation. */
  overflowAnchor: 'none' | 'auto'
}

export const DEFAULT_PLAIN_RENDERER_LAB: PlainRendererLabPrefs = {
  contentVisibility: true,
  intrinsicSize: 200,
  prependAnchor: true,
  aboveAnchor: true,
  overflowAnchor: 'none',
}

/** Merge a possibly-partial stored value over the defaults (prefs written by
 *  an older build simply lack newer knobs). */
export function resolvePlainRendererLab(stored: Partial<PlainRendererLabPrefs> | undefined): PlainRendererLabPrefs {
  return { ...DEFAULT_PLAIN_RENDERER_LAB, ...stored }
}

/** Compact "knob=value" list of every non-default knob, or null when the lab
 *  is entirely at defaults. Logged as `[plain-lab] ...` so device logs always
 *  name the configuration under test. */
export function plainLabSummary(lab: PlainRendererLabPrefs): string | null {
  const diffs: string[] = []
  for (const key of Object.keys(DEFAULT_PLAIN_RENDERER_LAB) as Array<keyof PlainRendererLabPrefs>) {
    if (lab[key] !== DEFAULT_PLAIN_RENDERER_LAB[key]) diffs.push(`${key}=${lab[key]}`)
  }
  return diffs.length > 0 ? diffs.join(' ') : null
}
