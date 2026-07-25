/**
 * Anchor-strategy resolution. The invariant that matters: native and JS
 * anchoring are MUTUALLY EXCLUSIVE -- running both double-compensates every
 * prepend, which is the bug the old hardcoded `overflow-anchor: none` existed
 * to avoid.
 */

import { describe, expect, it } from 'vitest'
import { type AnchorMode, resolveAnchorStrategy } from './anchor-strategy'

const MODES: AnchorMode[] = ['auto', 'native', 'js']

describe('resolveAnchorStrategy', () => {
  it('auto uses native anchoring where the engine has it', () => {
    expect(resolveAnchorStrategy('auto', true)).toMatchObject({
      resolved: 'native',
      overflowAnchor: 'auto',
      prependAnchor: false,
      aboveAnchor: false,
    })
  })

  it('auto falls back to the JS anchors on an engine without it (Safari 26 and older)', () => {
    expect(resolveAnchorStrategy('auto', false)).toMatchObject({
      resolved: 'js',
      overflowAnchor: 'none',
      prependAnchor: true,
      aboveAnchor: true,
    })
  })

  it('explicit modes ignore engine support (that is the point of the knob)', () => {
    expect(resolveAnchorStrategy('native', false).resolved).toBe('native')
    expect(resolveAnchorStrategy('js', true).resolved).toBe('js')
  })

  it.each(MODES)('never runs native and JS anchoring together (mode=%s)', mode => {
    for (const supported of [true, false]) {
      const s = resolveAnchorStrategy(mode, supported)
      const nativeOn = s.overflowAnchor === 'auto'
      const jsOn = s.prependAnchor || s.aboveAnchor
      expect(nativeOn && jsOn).toBe(false)
      expect(nativeOn || jsOn).toBe(true)
    }
  })
})
