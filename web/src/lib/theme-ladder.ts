/**
 * Derive the seven-step surface ladder + four text tokens for ANY theme.
 *
 * Why derive instead of hand-writing them into all 13 themes: the ladder is a
 * SHAPE (a sequence of ΔL offsets from the page), not a list of colours. Typing
 * it out per theme means 13 copies to keep in sync, and the first time someone
 * adds a theme they forget -- and that theme silently inherits the previous
 * theme's surfaces, because `applyTheme` only ever SETS variables and never
 * clears the ones a theme omits.
 *
 * The offsets come from real Tokyo Night, whose panel step is ΔL 0.08
 * (#1a1b26 -> #292e42). The floor is 0.045: below that a surface edge does not
 * survive a glance. Contrast ratio is the wrong instrument at the dark end --
 * it compresses until a visible step and an invisible one both read ~1.1:1.
 *
 * A theme may still override any of these by declaring the variable itself;
 * derivation only fills what is missing.
 */

/** Smallest ΔL that still reads as an edge at a glance. Below this, don't bother. */
export const LADDER_FLOOR = 0.045

/** ΔL from the page for each rung, in ladder order. */
const SURFACE_OFFSETS: Record<string, number> = {
  'surface-sunken': -0.05,
  'surface-raised': 0.07,
  'surface-overlay': 0.135,
  'surface-hover': 0.19,
  'border-subtle': 0.135,
  border: 0.25,
  'border-strong': 0.335,
}

/** Text tokens as a fraction of the way from the page to the foreground. */
const TEXT_MIX: Record<string, number> = {
  'fg-muted': 0.78,
  'fg-dim': 0.58,
  'fg-faint': 0.44,
}

/** Chroma rises with lightness -- a flat-chroma ramp goes muddy at the top. */
const CHROMA_GAIN = 1.6

export interface Oklch {
  l: number
  c: number
  h: number
}

const OKLCH_RE = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/

export function parseOklch(value: string): Oklch | null {
  const m = OKLCH_RE.exec(value)
  if (!m) return null
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) }
}

export function formatOklch({ l, c, h }: Oklch): string {
  const r = (n: number, p: number) => Number(n.toFixed(p))
  return `oklch(${r(l, 3)} ${r(c, 3)} ${r(h, 1)})`
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * Light themes have no headroom above white, so their ladder runs DOWNWARD --
 * a raised surface is a paler grey against a slightly deeper page, and the
 * heavy lifting falls to borders and shadow. Dark themes step up, where the
 * room is.
 */
function directionFor(bg: Oklch): number {
  return bg.l < 0.5 ? 1 : -1
}

function rung(bg: Oklch, offset: number, dir: number): Oklch {
  const raw = clamp(bg.l + offset * dir, 0.02, 0.99)
  /*
   * A rung that lands NEAR the page but not far enough from it is the exact
   * defect this whole ladder exists to kill: the old `--surface-inset` sat
   * 0.005 from the background -- different enough to look deliberate, far too
   * close to see. On a page at L 0.06 (Matrix) or L 0.97 (Claude) there is
   * simply no room left in that direction, and pretending otherwise produces
   * that same invisible-but-different state.
   *
   * So: take the room if it exists, and COLLAPSE to exactly the page if it
   * does not. A collapsed rung is honest -- the surface then takes its
   * identity from `--border-strong` instead of a fill step, which is a real
   * pattern rather than a broken one.
   */
  const l = Math.abs(raw - bg.l) >= LADDER_FLOOR ? raw : bg.l
  const lift = Math.abs(l - bg.l)
  return { l, c: clamp(bg.c + lift * CHROMA_GAIN * bg.c, 0, 0.4), h: bg.h }
}

function blend(bg: Oklch, fg: Oklch, t: number): Oklch {
  return {
    l: bg.l + (fg.l - bg.l) * t,
    c: bg.c + (fg.c - bg.c) * t,
    h: fg.h,
  }
}

/**
 * Fill in every ladder token the theme did not declare itself.
 * Returns a NEW record; the input is not mutated.
 */
export function deriveLadder(variables: Record<string, string>): Record<string, string> {
  const bg = parseOklch(variables.background ?? '')
  const fg = parseOklch(variables.foreground ?? '')
  if (!bg || !fg) return { ...variables }

  const out = { ...variables }
  const dir = directionFor(bg)

  for (const [token, offset] of Object.entries(SURFACE_OFFSETS)) {
    if (out[token]) continue
    out[token] = formatOklch(rung(bg, offset, dir))
  }
  for (const [token, t] of Object.entries(TEXT_MIX)) {
    if (out[token]) continue
    out[token] = formatOklch(blend(bg, fg, t))
  }

  /* `--input` and `--surface-inset` are the well you type into. They must sit
     BELOW the page, not level with it -- the old ramp had inset at 0.145
     against a 0.15 background, a 1.01:1 step, which is why an input was
     invisible until you clicked it. */
  const sunken = out['surface-sunken']
  if (sunken && !variables['surface-inset']) out['surface-inset'] = sunken
  if (sunken && !variables.input) out.input = sunken

  return out
}

const SURFACE_RUNGS = ['surface-sunken', 'background', 'surface-raised', 'surface-overlay', 'surface-hover']

/**
 * Smallest adjacent ΔL among the surface rungs, IGNORING rungs that collapsed
 * onto their neighbour by design (see `rung`). A collapsed rung is a deliberate
 * "there was no room here"; a rung sitting 0.005 away is the bug.
 */
export function smallestSurfaceStep(variables: Record<string, string>): number {
  const rungs = SURFACE_RUNGS.map(t => parseOklch(variables[t] ?? '')).filter((v): v is Oklch => v !== null)
  let worst = Number.POSITIVE_INFINITY
  for (let i = 1; i < rungs.length; i++) {
    const step = Math.abs(rungs[i].l - rungs[i - 1].l)
    if (step === 0) continue
    worst = Math.min(worst, step)
  }
  return Number.isFinite(worst) ? worst : 0
}

/** Rungs that had no room and collapsed onto the page. They lean on borders instead. */
export function collapsedRungs(variables: Record<string, string>): string[] {
  const bg = parseOklch(variables.background ?? '')
  if (!bg) return []
  return SURFACE_RUNGS.filter(t => {
    if (t === 'background') return false
    const v = parseOklch(variables[t] ?? '')
    return v !== null && v.l === bg.l
  })
}
