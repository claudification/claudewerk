/**
 * Inline SVG icons for ANVIL blocks.
 *
 * Why a local registry rather than importing lucide-react:
 * - This renderer emits an HTML STRING, so React components are unusable here.
 * - lucide-react ships no `exports` map, so `dist/esm/icons/*.mjs` is an
 *   internal layout detail with no stability contract. Deep-importing it would
 *   couple us to a path that can move on any release.
 * - Ten icons is ~30 lines of geometry. The coupling costs more than the copy.
 *
 * The geometry below was extracted from the installed lucide-react v1.23.0
 * (ISC licensed) rather than transcribed by hand, so it is exact. To refresh:
 * read `__iconNode` out of the matching file in that package.
 *
 * Keyed by NAME, never by unicode codepoint. A glyph key would put
 * tofu-prone characters back in the DSL source, which is read as plain text in
 * the spec, in diffs, in agent context, and in the code-block fallback when a
 * fence fails to render.
 */

export type IconName =
  | 'list-checks'
  | 'images'
  | 'palette'
  | 'type'
  | 'layout-grid'
  | 'text-cursor-input'
  | 'sliders-horizontal'
  | 'info'
  | 'triangle-alert'
  | 'octagon-alert'

/** Inner markup only; wrapped by `icon()` below. */
const GEOMETRY: Record<IconName, string> = {
  'list-checks':
    '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
  images:
    '<path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16"/><path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2"/><circle cx="13" cy="7" r="1" fill="currentColor"/><rect x="8" y="2" width="14" height="14" rx="2"/>',
  palette:
    '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>',
  type: '<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>',
  'layout-grid':
    '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  'text-cursor-input':
    '<path d="M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6"/><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"/><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"/><path d="M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1"/><path d="M9 6v12"/>',
  'sliders-horizontal':
    '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'triangle-alert':
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'octagon-alert':
    '<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/>',
}

const NAMES = new Set<string>(Object.keys(GEOMETRY))

export function isIconName(name: string): name is IconName {
  return NAMES.has(name)
}

/**
 * An `icon=` value the agent supplied. Unknown names fall back rather than
 * rendering an empty box, so a typo degrades to the block's default.
 */
export function resolveIcon(requested: unknown, fallback: IconName): IconName {
  return typeof requested === 'string' && isIconName(requested) ? requested : fallback
}

/** currentColor throughout, so it inherits the surrounding text colour. */
export function icon(name: IconName): string {
  return `<svg class="anvil-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GEOMETRY[name]}</svg>`
}
