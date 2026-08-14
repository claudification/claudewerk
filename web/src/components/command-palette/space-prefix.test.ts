import { describe, expect, it } from 'vitest'
import { derivePaletteMode } from './mode-detect'
import { applyDoubleSpaceGesture } from './space-prefix'

describe('applyDoubleSpaceGesture', () => {
  it('turns a double space on an empty filter into command mode', () => {
    expect(applyDoubleSpaceGesture('  ')).toBe('>')
    expect(derivePaletteMode(applyDoubleSpaceGesture('  ')!).mode).toBe('command')
  })

  it('accepts the iOS smart-punctuation spelling of a double space', () => {
    expect(applyDoubleSpaceGesture('. ')).toBe('>')
    expect(applyDoubleSpaceGesture('>. ')).toBe('')
  })

  it('toggles back out of command mode', () => {
    expect(applyDoubleSpaceGesture('>  ')).toBe('')
    expect(derivePaletteMode(applyDoubleSpaceGesture('>  ')!).mode).toBe('conversation')
  })

  it('leaves a single space alone so the gesture needs two presses', () => {
    expect(applyDoubleSpaceGesture(' ')).toBeNull()
    expect(applyDoubleSpaceGesture('> ')).toBeNull()
  })

  it('never touches real typing', () => {
    for (const typed of ['', 'clear cache', '  leading', 'a  b', '>clear', '> clear cache', 'S:~/', '@task']) {
      expect(applyDoubleSpaceGesture(typed)).toBeNull()
    }
  })
})
