/**
 * Plain Renderer Lab -- per-device experiment knobs for the plain
 * (non-virtualized) transcript renderer's SCROLL-BACK machinery. Stick-to-
 * bottom is settled; the problem this lab exists for is keeping the reader's
 * position stable while older history loads and content-visibility groups
 * inflate from their reserved height to their real one. The Experiments
 * settings tab flips these live (zustand prefs, localStorage) so we can A/B
 * on-device without a rebuild per variant.
 *
 * THE DEFAULTS ARE THE ANSWER, not a placeholder. THIS IS A SAFARI-FIRST
 * SURFACE -- Safari is the browser that has to be right; Chrome is a bonus.
 *
 * The mechanisms (see components/transcript/plain/ + globals.css):
 *  - content-visibility: auto + contain-intrinsic-size on each group. Skips
 *    offscreen LAYOUT (not React work -- every windowed group is in the DOM
 *    either way). DEFAULT OFF, because on WebKit it is a net loss:
 *      * its reserved height is the scroll-back jump amplifier -- whatever it
 *        under-reserves gets shoved into the reader's face when the box turns
 *        relevant, which while scrolling UP is just above the viewport;
 *      * WebKit never paints SVG text inside such a box (our Mermaid blocks)
 *        -- https://adactio.com/journal/21498;
 *      * details/summary inside such a box will not expand (Safari 18
 *        regression, https://bugs.webkit.org/show_bug.cgi?id=277573).
 *    OFF means real heights from first layout, so nothing above the reader
 *    ever changes size and there is nothing for an anchor to chase. The knob
 *    turns it back on for the offscreen-layout win on engines that behave.
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
  /** content-visibility:auto on each group (offscreen layout skipping).
   *  DEFAULT OFF: plain document flow, real heights from first layout, so
   *  nothing inflates above the viewport -- the jump dies at the source, and
   *  WebKit's two content-visibility painting bugs go with it. ON restores
   *  offscreen layout skipping, and with it the first-encounter inflation. */
  contentVisibility: boolean
  /** The flat reserved height (px), used only while `sizing` is 'flat'. 200 is
   *  far below a typical group, which is exactly why 'measured' is default. */
  intrinsicSize: number
}

export const DEFAULT_PLAIN_RENDERER_LAB: PlainRendererLabPrefs = {
  anchorMode: 'auto',
  sizing: 'measured',
  contentVisibility: false,
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
