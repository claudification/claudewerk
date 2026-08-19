/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { type ChordFlags, isPeekChordHeld, isPeekChordReleased } from './strip-peek-chord'

const flags = (over: Partial<ChordFlags> = {}): ChordFlags => ({
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  ...over,
})

describe('isPeekChordHeld', () => {
  it('holds for Cmd+Opt (macOS)', () => {
    expect(isPeekChordHeld(flags({ altKey: true, metaKey: true }))).toBe(true)
  })

  it('holds for Ctrl+Alt (Windows / Linux)', () => {
    expect(isPeekChordHeld(flags({ altKey: true, ctrlKey: true }))).toBe(true)
  })

  it('does NOT hold for bare Alt', () => {
    // The old binding. Alt alone is struck constantly for accented characters
    // and menu access, and every one of those popped the strip open.
    expect(isPeekChordHeld(flags({ altKey: true }))).toBe(false)
  })

  it('does NOT hold for bare Cmd or bare Ctrl', () => {
    expect(isPeekChordHeld(flags({ metaKey: true }))).toBe(false)
    expect(isPeekChordHeld(flags({ ctrlKey: true }))).toBe(false)
  })

  it('does NOT hold for no modifiers at all', () => {
    expect(isPeekChordHeld(flags())).toBe(false)
  })

  it('tolerates extra modifiers rather than fighting them', () => {
    expect(isPeekChordHeld(flags({ altKey: true, metaKey: true, ctrlKey: true }))).toBe(true)
  })
})

describe('isPeekChordReleased', () => {
  it('is the exact inverse of held', () => {
    for (const f of [
      flags(),
      flags({ altKey: true }),
      flags({ metaKey: true }),
      flags({ altKey: true, metaKey: true }),
      flags({ altKey: true, ctrlKey: true }),
    ]) {
      expect(isPeekChordReleased(f)).toBe(!isPeekChordHeld(f))
    }
  })

  it('releases when EITHER modifier goes up, not just Alt', () => {
    // The browser reports post-release state, so letting go of Cmd while still
    // holding Opt must end the peek.
    expect(isPeekChordReleased(flags({ altKey: true }))).toBe(true)
    expect(isPeekChordReleased(flags({ metaKey: true }))).toBe(true)
  })
})
