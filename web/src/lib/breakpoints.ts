/**
 * Viewport breakpoints, in ONE place.
 *
 * WHY THIS FILE EXISTS: we shipped two numbers that disagreed. `isMobileViewport()`
 * answered "< 640px" while the sidebar/hamburger layout switched at Tailwind's
 * `lg` (1024px). Everything in between -- every tablet, every half-width desktop
 * window -- therefore ran the DESKTOP branch of the JavaScript while showing the
 * MOBILE chrome: the hamburger was visible but the code believed there was a
 * docked sidebar behind it.
 *
 * They are still two different numbers, but now deliberately, and named for what
 * they actually decide:
 *
 *  - `PHONE_BREAKPOINT`  -- "is this a phone": no hover, a soft keyboard that eats
 *    half the screen, thumb-sized hit targets. Drives input focus, copy menus,
 *    link handling. Matches Tailwind `sm`.
 *  - `LAYOUT_BREAKPOINT` -- "does the sidebar overlay the content instead of
 *    sitting beside it". Matches Tailwind `lg`, and MUST stay in lockstep with the
 *    `lg:` variants in `components/sidebar/sidebar.tsx`. Change one, change both.
 */

/** Tailwind `sm`. Below this is a phone. */
export const PHONE_BREAKPOINT = 640

/** Tailwind `lg`. Below this the sidebar overlays rather than docks. */
const LAYOUT_BREAKPOINT = 1024

/**
 * Media query for "the sidebar is an overlay". The 0.02px shaves the boundary so
 * this and the `lg:` utilities never both match at exactly 1024px.
 */
export const SIDEBAR_OVERLAY_QUERY = `(max-width: ${LAYOUT_BREAKPOINT - 0.02}px)`

/** Imperative read, for the rare non-reactive call site (state initialisers). */
export function isSidebarOverlay(): boolean {
  return window.matchMedia(SIDEBAR_OVERLAY_QUERY).matches
}
