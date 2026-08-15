import { describe, expect, it } from 'bun:test'
import {
  EPIC_HUE_BY_NAME,
  EPIC_HUE_SLOTS,
  epicHue,
  epicHueSlot,
  nearestEpicColorName,
  parseEpicColor,
} from './epic-color'

describe('epicHue', () => {
  it('is stable for the same id', () => {
    expect(epicHue('anvil-epic')).toBe(epicHue('anvil-epic'))
  })

  it('lands in [0, 360)', () => {
    for (const id of ['a', 'anvil-epic', 'spawn-unify-epic', '', 'x'.repeat(200)]) {
      const hue = epicHue(id)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })

  it('separates the epics actually on this board', () => {
    const hues = ['anvil-epic', 'spawn-unify-epic', 'epic-conversation-optimization'].map(id => epicHue(id))
    expect(new Set(hues).size).toBe(3)
  })

  it('spreads slots evenly across the wheel', () => {
    // Every reachable hue, sorted -- the guarantee is about the WORST gap, which
    // is what decides whether two epics are tellable apart.
    const ids = Array.from({ length: 4000 }, (_, i) => `epic-${i}`)
    const hues = [...new Set(ids.map(id => epicHue(id)))].toSorted((a, b) => a - b)
    expect(hues.length).toBe(EPIC_HUE_SLOTS)
    for (let i = 1; i < hues.length; i++) expect(hues[i] - hues[i - 1]).toBeGreaterThanOrEqual(22)
  })
})

describe('epicHueSlot', () => {
  it('stays inside the slot count', () => {
    for (const id of ['a', 'bb', 'anvil-epic', 'zzz-9']) {
      expect(epicHueSlot(id)).toBeGreaterThanOrEqual(0)
      expect(epicHueSlot(id)).toBeLessThan(EPIC_HUE_SLOTS)
    }
  })
})

describe('parseEpicColor', () => {
  it('takes a name', () => {
    expect(parseEpicColor('teal')).toBe(EPIC_HUE_BY_NAME.teal)
    expect(parseEpicColor('  TEAL ')).toBe(EPIC_HUE_BY_NAME.teal)
  })

  it('takes a raw hue, with or without deg', () => {
    expect(parseEpicColor('178')).toBe(178)
    expect(parseEpicColor('178deg')).toBe(178)
  })

  it('wraps out-of-range hues instead of rejecting them', () => {
    expect(parseEpicColor('380')).toBe(20)
    expect(parseEpicColor('-20')).toBe(340)
  })

  it('mutes a typo rather than blanking the epic', () => {
    expect(parseEpicColor('chartreusey')).toBeNull()
    expect(parseEpicColor('')).toBeNull()
    expect(parseEpicColor(undefined)).toBeNull()
  })
})

describe('epicHue with override', () => {
  it('lets a valid override win', () => {
    expect(epicHue('anvil-epic', 'teal')).toBe(EPIC_HUE_BY_NAME.teal)
  })

  it('falls back to the derived hue when the override is junk', () => {
    expect(epicHue('anvil-epic', 'nope')).toBe(epicHue('anvil-epic'))
  })
})

describe('nearestEpicColorName', () => {
  it('round-trips every named hue', () => {
    for (const [name, hue] of Object.entries(EPIC_HUE_BY_NAME)) {
      expect(nearestEpicColorName(hue)).toBe(name)
    }
  })

  it('wraps around the wheel', () => {
    expect(nearestEpicColorName(359)).toBe('red')
  })
})
