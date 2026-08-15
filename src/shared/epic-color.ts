/**
 * A stable, distinct colour per epic -- derived, not stored.
 *
 * Deriving it from the id means every epic that already exists has a colour
 * today, with no migration and no write. Storing it would mean a board where
 * the epics created before the feature are grey and the ones created after are
 * not, which reads as a bug rather than as history.
 *
 * The override (`color:` on the epic card) is the escape hatch: pick a name or
 * a hue and it wins. That is the only thing worth persisting, because it is the
 * only part a hash cannot know.
 *
 * Output is a HUE, never a CSS string. The board's palette lives in
 * `globals.css` as oklch tokens in one narrow lightness/chroma band; handing
 * back a hue lets the panel place an epic inside that band instead of beside
 * it. See `web/src/lib/cards/epic-color-vars.ts` for the CSS half.
 */

/** Named hues a human can actually type into frontmatter. */
export const EPIC_HUE_BY_NAME: Record<string, number> = {
  red: 25,
  orange: 55,
  amber: 75,
  yellow: 95,
  lime: 125,
  green: 150,
  teal: 178,
  cyan: 200,
  blue: 245,
  indigo: 275,
  violet: 300,
  magenta: 330,
}

/**
 * How many distinct hues the hash can land on. More slots than this and two
 * epics stop being tellable apart in a 4px rail.
 *
 * The slots are spaced EVENLY, not by golden angle. Golden angle is the right
 * answer when colours are handed out in sequence and each new one should avoid
 * its predecessors; here the hash already scatters, so all the angle does is
 * make the worst-case gap worse -- 13 degrees against an even 22.5.
 */
export const EPIC_HUE_SLOTS = 16

/** Nudge off 0 so slot 0 is a warm red rather than the raw edge of the wheel. */
const HUE_OFFSET = 12

/** FNV-1a, 32-bit. Chosen because it is stable across runtimes and tiny --
 *  an epic must not change colour because the panel was rebuilt. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Which of the `EPIC_HUE_SLOTS` an id falls into. Exported for tests + docs. */
export function epicHueSlot(epicId: string): number {
  return fnv1a(epicId) % EPIC_HUE_SLOTS
}

/**
 * Parse a `color:` frontmatter value. Accepts a name (`teal`) or a raw hue
 * (`178`, `178deg`). Anything else is not an error -- it just does not win, and
 * the derived hue stands. A typo should mute the override, never blank the epic.
 */
export function parseEpicColor(value: string | undefined): number | null {
  if (!value) return null
  const key = value.trim().toLowerCase()
  const named = EPIC_HUE_BY_NAME[key]
  if (named !== undefined) return named
  const n = Number.parseFloat(key.replace(/deg$/, ''))
  if (!Number.isFinite(n)) return null
  return ((n % 360) + 360) % 360
}

/** The hue an epic paints with: the override if it parses, else the derived one. */
export function epicHue(epicId: string, override?: string): number {
  const parsed = parseEpicColor(override)
  if (parsed !== null) return parsed
  return Math.round((epicHueSlot(epicId) * (360 / EPIC_HUE_SLOTS) + HUE_OFFSET) % 360)
}

/** The name whose hue is closest to `hue` -- what a colour picker shows as selected. */
export function nearestEpicColorName(hue: number): string {
  const entries = Object.entries(EPIC_HUE_BY_NAME)
  let best = entries[0]
  let bestDist = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    const raw = Math.abs(entry[1] - hue)
    const dist = Math.min(raw, 360 - raw)
    if (dist < bestDist) {
      bestDist = dist
      best = entry
    }
  }
  return best[0]
}
