import { describe, expect, it } from 'vitest'
import { derivePaletteMode } from './mode-detect'
import { applyDoubleSpaceGesture } from './space-prefix'

describe('applyDoubleSpaceGesture', () => {
  it('turns a double space on an empty filter into command mode, with breathing room', () => {
    expect(applyDoubleSpaceGesture('  ')).toBe('> ')
    expect(derivePaletteMode(applyDoubleSpaceGesture('  ')!).mode).toBe('command')
  })

  it('toggles back out of command mode after two more taps', () => {
    expect(applyDoubleSpaceGesture('>   ')).toBe('')
    expect(derivePaletteMode(applyDoubleSpaceGesture('>   ')!).mode).toBe('conversation')
  })

  it('toggles back from a bare > too, since the footer chip inserts it without the space', () => {
    expect(applyDoubleSpaceGesture('>  ')).toBe('')
  })

  it('accepts however the OS spells the gesture, including iOS smart punctuation', () => {
    for (const spelling of ['. ', ' .', '..', '   ']) {
      expect(applyDoubleSpaceGesture(spelling)).toBe('> ')
      expect(applyDoubleSpaceGesture(`>${spelling}`)).toBe('')
    }
  })

  it('leaves a single tap alone so the gesture needs two', () => {
    expect(applyDoubleSpaceGesture(' ')).toBeNull()
    expect(applyDoubleSpaceGesture('.')).toBeNull()
    expect(applyDoubleSpaceGesture('> ')).toBeNull()
    expect(applyDoubleSpaceGesture('>')).toBeNull()
  })

  it('never touches real typing', () => {
    for (const typed of ['', 'clear cache', '  leading', 'a  b', '>clear', '> clear cache', 'S:~/', '@task', '.env']) {
      expect(applyDoubleSpaceGesture(typed)).toBeNull()
    }
  })
})
