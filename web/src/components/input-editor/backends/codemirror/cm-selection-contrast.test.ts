import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AA_BODY, composite, contrastRatio, oklchToSrgb } from '@/lib/contrast'
import { deriveLadder, parseOklch } from '@/lib/theme-ladder'
import { THEMES } from '@/lib/themes'

/**
 * The CM6 selection tint is `--primary`, and `.cm-md-link`, `.cm-md-heading`
 * and `.cm-md-emphasis` are ALSO `--primary`. Selected markdown is therefore
 * primary text on a primary-tinted fill, and the only thing keeping it legible
 * is the alpha.
 *
 * Nothing guarded that pair. When `--primary` moved for the neon tier the fill
 * got brighter and worst-case syntax contrast slid from 5.45:1 to 5.16:1 --
 * still passing, but drifting in the wrong direction with nothing watching. A
 * few more nudges in that direction and it would have gone under without any
 * test noticing.
 *
 * Reads the alpha out of the theme source so the test cannot silently disagree
 * with what actually ships.
 */

const EXTENSIONS = join(process.cwd(), 'src/components/input-editor/backends/codemirror/extensions.ts')

/** Pull `color-mix(in oklch, var(--color-primary) NN%, transparent)` alphas. */
function selectionAlphas(): { focused: number; unfocused: number } {
  const src = readFileSync(EXTENSIONS, 'utf8')
  const all = [...src.matchAll(/cm-selectionBackground'[^}]*?var\(--color-([a-z-]+)\)\s+(\d+)%/gs)]
  expect(all.length, 'expected exactly two selection rules').toBe(2)
  for (const m of all) {
    expect(m[1], 'the selection tint must stay NEUTRAL -- a syntax hue collides with selected text').toBe(
      'border-strong',
    )
  }
  const nums = all.map(m => Number(m[2]))
  return { unfocused: Math.min(...nums), focused: Math.max(...nums) }
}

/** Token names the CM6 theme paints text with, inside the input well. */
const SYNTAX_TOKENS = ['primary', 'accent', 'active', 'foreground']

/** The theme that actually ships. Other themes are tracked debt, not this test's job. */
const DEFAULT_THEME = 'tokyo-night'

describe('CM6 selection keeps syntax readable', () => {
  const { focused, unfocused } = selectionAlphas()

  it('parses both alphas out of the theme source', () => {
    expect(focused).toBeGreaterThan(unfocused)
    expect(focused).toBeLessThanOrEqual(70)
  })

  /*
   * SCOPED TO THE SHIPPED DEFAULT, DELIBERATELY.
   *
   * Running this across all thirteen themes showed the problem is far older
   * and wider than the neon change: solving for a feasible alpha per theme,
   * five of them (nord, gruvbox, github-light, claude, claude-dark) have NO
   * value that keeps every syntax colour readable, because their --primary and
   * their neutrals are too close for any selection fill to sit between.
   *
   * That is real debt, but it is not this bug, and hand-tuning twelve themes
   * would bury the fix Jonas actually asked for. Tracked separately; this test
   * holds the line on the theme that ships.
   */
  it(`${DEFAULT_THEME}: every syntax colour clears AA on the selection`, () => {
    const theme = THEMES.find(t => t.id === DEFAULT_THEME)
    expect(theme, `${DEFAULT_THEME} must exist`).toBeDefined()
    const vars = deriveLadder(theme!.variables)
    const well = parseOklch(vars.input ?? vars.background ?? '')!
    const tint = parseOklch(vars['border-strong'] ?? '')!

    const fill = composite(oklchToSrgb(tint), oklchToSrgb(well), focused / 100)
    for (const token of SYNTAX_TOKENS) {
      const colour = parseOklch(vars[token] ?? '')
      if (!colour) continue
      const ratio = contrastRatio(oklchToSrgb(colour), fill)
      expect(ratio, `--${token} on the focused selection is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_BODY)
    }
  })

  it('the selection is still visible against the well it sits in', () => {
    // Quieting the fill must not quiet it into nothing.
    const vars = deriveLadder(THEMES.find(t => t.id === DEFAULT_THEME)!.variables)
    const well = parseOklch(vars.input ?? '')!
    const tint = parseOklch(vars['border-strong'] ?? '')!
    const fill = composite(oklchToSrgb(tint), oklchToSrgb(well), focused / 100)
    expect(contrastRatio(fill, oklchToSrgb(well))).toBeGreaterThan(1.3)
  })
})
