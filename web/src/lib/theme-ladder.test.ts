import { describe, expect, it } from 'vitest'

import {
  collapsedRungs,
  deriveLadder,
  formatOklch,
  LADDER_FLOOR,
  parseOklch,
  smallestSurfaceStep,
} from './theme-ladder'
import { THEMES } from './themes'

const LADDER_TOKENS = [
  'surface-sunken',
  'surface-raised',
  'surface-overlay',
  'surface-hover',
  'border-subtle',
  'border',
  'border-strong',
  'fg-muted',
  'fg-dim',
  'fg-faint',
]

describe('parseOklch', () => {
  it('reads the three components', () => {
    expect(parseOklch('oklch(0.165 0.022 275)')).toEqual({ l: 0.165, c: 0.022, h: 275 })
  })

  it('returns null for anything that is not oklch', () => {
    expect(parseOklch('#1a1b26')).toBeNull()
    expect(parseOklch('')).toBeNull()
  })

  it('round-trips through formatOklch', () => {
    const parsed = parseOklch('oklch(0.3 0.037 273)')
    expect(parsed).not.toBeNull()
    expect(parseOklch(formatOklch(parsed!))).toEqual(parsed)
  })
})

describe('deriveLadder', () => {
  it('fills every ladder token a theme omits', () => {
    const derived = deriveLadder({ background: 'oklch(0.165 0.022 275)', foreground: 'oklch(0.9 0.045 275)' })
    for (const token of LADDER_TOKENS) expect(derived[token], token).toBeTruthy()
  })

  it('never overwrites a value the theme declared itself', () => {
    const derived = deriveLadder({
      background: 'oklch(0.165 0.022 275)',
      foreground: 'oklch(0.9 0.045 275)',
      'surface-raised': 'oklch(0.5 0.1 200)',
    })
    expect(derived['surface-raised']).toBe('oklch(0.5 0.1 200)')
  })

  it('leaves a theme alone when it cannot parse the base colours', () => {
    const input = { background: '#1a1b26', foreground: '#c0caf5' }
    expect(deriveLadder(input)).toEqual(input)
  })

  it('sinks inputs BELOW the page, never level with it', () => {
    // The bug this guards: --surface-inset was 0.145 against a 0.15 background,
    // a 1.01:1 step, so you could not see where to type.
    const derived = deriveLadder({ background: 'oklch(0.165 0.022 275)', foreground: 'oklch(0.9 0.045 275)' })
    const page = parseOklch('oklch(0.165 0.022 275)')!
    for (const token of ['input', 'surface-inset']) {
      const well = parseOklch(derived[token])
      expect(well, token).not.toBeNull()
      expect(page.l - well!.l, `${token} must sit below the page`).toBeGreaterThanOrEqual(LADDER_FLOOR)
    }
  })

  it('collapses a rung that has no room rather than leaving it invisibly different', () => {
    // Matrix sits at L 0.06 -- there is nothing below it to sink into. The old
    // failure mode was landing 0.005 away: deliberate-looking, unseeable.
    const derived = deriveLadder({ background: 'oklch(0.06 0.01 150)', foreground: 'oklch(0.9 0.2 150)' })
    expect(parseOklch(derived['surface-sunken'])!.l).toBe(0.06)
    expect(collapsedRungs(derived)).toContain('surface-sunken')
  })

  it('steps downward for light themes, where there is no headroom above white', () => {
    const derived = deriveLadder({ background: 'oklch(0.98 0.005 260)', foreground: 'oklch(0.2 0.01 260)' })
    const page = parseOklch('oklch(0.98 0.005 260)')!
    expect(parseOklch(derived['surface-raised'])!.l).toBeLessThan(page.l)
  })
})

describe('every shipped theme clears the legibility floor', () => {
  it.each(THEMES.map(t => [t.id, t] as const))('%s', (_id, theme) => {
    const step = smallestSurfaceStep(deriveLadder(theme.variables))
    expect(step).toBeGreaterThanOrEqual(LADDER_FLOOR)
  })

  /*
   * THE invariant. Every rung is either far enough away to see, or exactly on
   * top of its neighbour. The zone in between -- visibly different to a colour
   * picker, invisible to a human -- is what shipped for a year and is what
   * Jonas was looking at when he said the windows had no contrast.
   */
  it.each(THEMES.map(t => [t.id, t] as const))('%s has no rung in the invisible-but-different zone', (_id, theme) => {
    const derived = deriveLadder(theme.variables)
    const rungs = ['surface-sunken', 'background', 'surface-raised', 'surface-overlay', 'surface-hover']
    for (let i = 1; i < rungs.length; i++) {
      const a = parseOklch(derived[rungs[i - 1]] ?? '')
      const b = parseOklch(derived[rungs[i]] ?? '')
      if (!a || !b) continue
      const step = Math.abs(b.l - a.l)
      const ok = step === 0 || step >= LADDER_FLOOR
      expect(ok, `${rungs[i - 1]} -> ${rungs[i]} is ΔL ${step.toFixed(3)}`).toBe(true)
    }
  })

  it.each(THEMES.map(t => [t.id, t] as const))('%s defines every ladder token', (_id, theme) => {
    const derived = deriveLadder(theme.variables)
    for (const token of LADDER_TOKENS) expect(derived[token], token).toBeTruthy()
  })
})
