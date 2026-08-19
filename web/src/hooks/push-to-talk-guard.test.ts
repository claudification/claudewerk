/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { CHORD_GRACE_MS, hasForeignModifier, type ModifierFlags } from './push-to-talk-guard'

const flags = (over: Partial<ModifierFlags> = {}): ModifierFlags => ({
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...over,
})

describe('hasForeignModifier', () => {
  it('does NOT treat a modifier hold key as foreign to itself', () => {
    // Otherwise binding push-to-talk to Alt would mean Alt could never start it.
    expect(hasForeignModifier('AltLeft', flags({ altKey: true }))).toBe(false)
    expect(hasForeignModifier('AltRight', flags({ altKey: true }))).toBe(false)
    expect(hasForeignModifier('MetaLeft', flags({ metaKey: true }))).toBe(false)
    expect(hasForeignModifier('ControlLeft', flags({ ctrlKey: true }))).toBe(false)
    expect(hasForeignModifier('ShiftLeft', flags({ shiftKey: true }))).toBe(false)
  })

  it('catches THE collision: Cmd already down when Alt lands', () => {
    expect(hasForeignModifier('AltLeft', flags({ altKey: true, metaKey: true }))).toBe(true)
  })

  it('catches Ctrl+Alt, the Windows half of the same chord', () => {
    expect(hasForeignModifier('AltRight', flags({ altKey: true, ctrlKey: true }))).toBe(true)
  })

  it('is quiet for a bare press with nothing else held', () => {
    expect(hasForeignModifier('F13', flags())).toBe(false)
    expect(hasForeignModifier('AltLeft', flags({ altKey: true }))).toBe(false)
  })

  it('flags any modifier for a NON-modifier hold key', () => {
    for (const flag of ['altKey', 'metaKey', 'ctrlKey', 'shiftKey'] as const) {
      expect(hasForeignModifier('F13', flags({ [flag]: true }))).toBe(true)
    }
  })

  it('treats OS-prefixed codes as the meta key', () => {
    expect(hasForeignModifier('OSLeft', flags({ metaKey: true }))).toBe(false)
  })
})

describe('CHORD_GRACE_MS', () => {
  it('is long enough for a deliberate chord and short enough to feel instant', () => {
    expect(CHORD_GRACE_MS).toBeGreaterThanOrEqual(50)
    expect(CHORD_GRACE_MS).toBeLessThanOrEqual(120)
  })
})
