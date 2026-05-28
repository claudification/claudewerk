/**
 * Per-project accent color. A stable hue derived from the project label so the
 * same project always wears the same color across reloads (no persistence).
 *
 * Returned as inline-style strings, NOT Tailwind classes -- dynamic color
 * classes (`border-${x}-500`) get purged by the build, so we feed hex/rgba
 * straight into `style={{ borderColor, background }}`.
 */

// Tailwind ~400-level tones (r,g,b). Readable on the dark sheaf background,
// distinct enough to tell adjacent projects apart at a glance.
const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [56, 189, 248], // sky-400
  [52, 211, 153], // emerald-400
  [251, 191, 36], // amber-400
  [248, 113, 113], // rose-400
  [167, 139, 250], // violet-400
  [244, 114, 182], // pink-400
  [45, 212, 191], // teal-400
  [251, 146, 60], // orange-400
  [129, 140, 248], // indigo-400
  [163, 230, 53], // lime-400
]

export interface Accent {
  /** Solid border color. */
  border: string
  /** Faint background tint for the header. */
  tint: string
}

function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  return h >>> 0
}

export function accentFor(label: string): Accent {
  const [r, g, b] = PALETTE[hash(label) % PALETTE.length]
  return {
    border: `rgb(${r} ${g} ${b})`,
    tint: `rgb(${r} ${g} ${b} / 0.06)`,
  }
}
