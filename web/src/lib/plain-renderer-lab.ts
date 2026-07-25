/**
 * Plain Renderer Lab -- per-device experiment knobs for the plain
 * (non-virtualized) transcript renderer's SCROLL-BACK machinery. Stick-to-
 * bottom is settled; the problem this lab exists for is keeping the reader's
 * position stable while older history loads and content-visibility groups
 * inflate from their reserved height to their real one. The Experiments
 * settings tab flips these live (zustand prefs, localStorage) so we can A/B
 * on-device without a rebuild per variant.
 *
 * THE DEFAULTS ARE THE ANSWER, not a placeholder: accurate per-group heights
 * so nothing inflates by much, and the browser's own scroll anchoring wherever
 * it exists. The knobs below exist to fall BACK to the older behaviors and
 * prove which one is doing the work.
 *
 * The mechanisms under test (see components/transcript/plain/ + globals.css):
 *  - content-visibility: auto + contain-intrinsic-size on each group. Skips
 *    offscreen layout. Its reserved height is the scroll-back jump amplifier:
 *    whatever it under-reserves gets shoved into the reader's face when the
 *    box becomes relevant. `sizing` picks how that height is chosen.
 *  - native scroll anchoring (`overflow-anchor: auto`) -- in layout, never a
 *    frame late. Chrome/Firefox for years, WebKit from Safari 27.
 *  - prepend anchor (use-prepend-anchor.ts): scrollHeight-delta compensation
 *    on the commit where older content lands. The Safari-26-and-older path.
 *  - above-viewport anchor (use-above-anchor.ts): ResizeObserver polyfill that
 *    compensates inflation of groups above the viewport. Same fallback path.
 * See memory: project_transcript_scrollback_hold, project_transcript_plain_renderer.
 */

import type { AnchorMode, GroupSizing } from '@/components/transcript/plain/anchor-strategy'

export interface PlainRendererLabPrefs {
  /** Who holds the reader's position while content above changes.
   *  'auto' (default) = native scroll anchoring where the engine has it, our
   *  JS anchors where it does not. 'native' / 'js' force one side, for A/B.
   *  Never both: they double-compensate every prepend. */
  anchorMode: AnchorMode
  /** How a not-yet-rendered group's reserved height is chosen.
   *  'measured' (default) = real height from the shared per-conversation cache,
   *  else a content-derived estimate (group-sizing.ts).
   *  'flat' = one `intrinsicSize` for every group -- the original guess, kept
   *  so the "is accurate sizing actually doing anything?" question stays
   *  answerable on-device. */
  sizing: GroupSizing
  /** content-visibility:auto on each group (offscreen layout skipping). OFF =
   *  plain document flow, real heights from first layout, so nothing inflates
   *  above the viewport -- kills the jump at the source (costs offscreen-skip
   *  perf on very large windows). */
  contentVisibility: boolean
  /** The flat reserved height (px), used only while `sizing` is 'flat'. 200 is
   *  far below a typical group, which is exactly why 'measured' is default. */
  intrinsicSize: number
}

export const DEFAULT_PLAIN_RENDERER_LAB: PlainRendererLabPrefs = {
  anchorMode: 'auto',
  sizing: 'measured',
  contentVisibility: true,
  intrinsicSize: 200,
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
